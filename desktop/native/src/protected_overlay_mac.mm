#include <node_api.h>

#import <AVFoundation/AVFoundation.h>
#import <Cocoa/Cocoa.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <vector>

namespace {
constexpr CGFloat kPadding = 14;
constexpr CGFloat kDragHeight = 20;
constexpr CGFloat kMaxPixelDimension = 4096;
char kProtectedViewKey;
}

API_AVAILABLE(macos(14.4))
@interface AceProtectedOverlayView : NSView
- (BOOL)updateText:(NSString*)text identifier:(NSString*)identifier
          fontSize:(CGFloat)fontSize textColor:(NSColor*)color opacity:(CGFloat)opacity
         streaming:(BOOL)streaming follow:(BOOL)follow;
- (BOOL)isHealthy;
- (void)retire;
@end

@implementation AceProtectedOverlayView {
  AVSampleBufferDisplayLayer* _video;
  AVSampleBufferVideoRenderer* _renderer;
  id _failureObserver;
  NSTextStorage* _text;
  NSLayoutManager* _layout;
  NSTextContainer* _container;
  NSString* _identifier;
  CGFloat _scroll;
  CGFloat _maxScroll;
  CFTimeInterval _firstFrameAt;
  BOOL _failed;
}

- (instancetype)initWithFrame:(NSRect)frame {
  self = [super initWithFrame:frame];
  if (!self) return nil;

  self.wantsLayer = YES;
  self.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  self.layer.masksToBounds = YES;
  _video = [AVSampleBufferDisplayLayer layer];
  _video.preventsCapture = YES;
  _video.videoGravity = AVLayerVideoGravityResize;
  _renderer = _video.sampleBufferRenderer;
  if (!_video.preventsCapture || !_renderer) return nil;
  [self.layer addSublayer:_video];

  _text = [[NSTextStorage alloc] init];
  _layout = [[NSLayoutManager alloc] init];
  _container = [[NSTextContainer alloc] initWithContainerSize:NSZeroSize];
  _container.lineFragmentPadding = 0;
  [_layout addTextContainer:_container];
  [_text addLayoutManager:_layout];

  __weak AceProtectedOverlayView* weakSelf = self;
  _failureObserver = [NSNotificationCenter.defaultCenter
      addObserverForName:AVSampleBufferDisplayLayerFailedToDecodeNotification
      object:_video queue:NSOperationQueue.mainQueue
      usingBlock:^(NSNotification* notification) {
        [weakSelf fail];
      }];
  return self;
}

- (void)dealloc {
  if (_failureObserver) [NSNotificationCenter.defaultCenter removeObserver:_failureObserver];
}

- (BOOL)isFlipped { return YES; }
- (BOOL)acceptsFirstMouse:(NSEvent*)event { return YES; }

- (void)retire {
  _video.hidden = YES;
  [_video removeFromSuperlayer];
  [_renderer flushWithRemovalOfDisplayedImage:YES completionHandler:nil];
}

- (void)fail {
  _failed = YES;
  [self retire];
}

- (BOOL)isHealthy {
  if (_failed || !_video.preventsCapture ||
      _renderer.status == AVQueuedSampleBufferRenderingStatusFailed ||
      _renderer.requiresFlushToResumeDecoding ||
      (_firstFrameAt > 0 && !_video.readyForDisplay && CACurrentMediaTime() - _firstFrameAt > 2)) {
    [self fail];
    return NO;
  }
  return YES;
}

- (NSRect)textRect {
  return NSMakeRect(kPadding, kDragHeight,
                    std::max(CGFloat{1}, NSWidth(self.bounds) - 2 * kPadding),
                    std::max(CGFloat{1}, NSHeight(self.bounds) - kDragHeight - kPadding));
}

- (void)layoutText {
  NSRect area = [self textRect];
  _container.containerSize = NSMakeSize(NSWidth(area), CGFLOAT_MAX);
  [_layout ensureLayoutForTextContainer:_container];
  _maxScroll = std::max(CGFloat{0},
      NSHeight([_layout usedRectForTextContainer:_container]) - NSHeight(area));
}

- (BOOL)updateText:(NSString*)text identifier:(NSString*)identifier
          fontSize:(CGFloat)fontSize textColor:(NSColor*)color opacity:(CGFloat)opacity
         streaming:(BOOL)streaming follow:(BOOL)follow {
  if (![self isHealthy]) return NO;
  BOOL newAnswer = ![_identifier isEqualToString:identifier];
  BOOL atBottom = _maxScroll - _scroll <= 28;
  _identifier = identifier;
  NSMutableParagraphStyle* paragraph = [[NSMutableParagraphStyle alloc] init];
  paragraph.lineBreakMode = NSLineBreakByWordWrapping;
  NSAttributedString* styledText = [[NSAttributedString alloc] initWithString:text attributes:@{
    NSFontAttributeName: [NSFont monospacedSystemFontOfSize:fontSize weight:NSFontWeightRegular],
    NSForegroundColorAttributeName: color,
    NSParagraphStyleAttributeName: paragraph
  }];
  [_text setAttributedString:styledText];
  [self layoutText];
  if (newAnswer) _scroll = 0;
  if (streaming && follow && (newAnswer || atBottom)) _scroll = _maxScroll;
  _scroll = std::min(_scroll, _maxScroll);

  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  _video.opacity = opacity;
  [CATransaction commit];
  return [self submitImage];
}

- (void)layout {
  [super layout];
  if (_text.length == 0 || _failed) return;
  [self layoutText];
  _scroll = std::min(_scroll, _maxScroll);
  [self submitImage];
}

- (void)viewDidChangeBackingProperties {
  [super viewDidChangeBackingProperties];
  if (_text.length > 0 && !_failed) [self submitImage];
}

- (void)mouseDown:(NSEvent*)event {
  if ([self convertPoint:event.locationInWindow fromView:nil].y < kDragHeight) {
    [self.window performWindowDragWithEvent:event];
  }
}

- (void)scrollWheel:(NSEvent*)event {
  CGFloat multiplier = event.hasPreciseScrollingDeltas ? 1 : 12;
  CGFloat offset = std::clamp(_scroll - event.scrollingDeltaY * multiplier, CGFloat{0}, _maxScroll);
  if (offset == _scroll || _failed) return;
  _scroll = offset;
  [self submitImage];
}

- (BOOL)submitImage {
  if (![self isHealthy]) return NO;
  const CGFloat pointsWide = NSWidth(self.bounds);
  const CGFloat pointsHigh = NSHeight(self.bounds);
  if (pointsWide < 1 || pointsHigh < 1) return YES;
  const CGFloat scale = std::min(self.window.backingScaleFactor,
      kMaxPixelDimension / std::max(pointsWide, pointsHigh));
  const size_t width = std::max(size_t{1}, static_cast<size_t>(std::ceil(pointsWide * scale)));
  const size_t height = std::max(size_t{1}, static_cast<size_t>(std::ceil(pointsHigh * scale)));
  NSDictionary* attrs = @{(__bridge NSString*)kCVPixelBufferIOSurfacePropertiesKey: @{}};
  CVPixelBufferRef pixels = nullptr;
  if (CVPixelBufferCreate(nullptr, width, height, kCVPixelFormatType_32BGRA,
                          (__bridge CFDictionaryRef)attrs, &pixels) != kCVReturnSuccess) {
    [self fail];
    return NO;
  }

  BOOL painted = [self paintPixels:pixels scale:scale];
  CMVideoFormatDescriptionRef format = nullptr;
  CMSampleBufferRef sample = nullptr;
  if (painted && CMVideoFormatDescriptionCreateForImageBuffer(nullptr, pixels, &format) == noErr) {
    CMSampleTimingInfo timing = {kCMTimeInvalid, CMClockGetTime(CMClockGetHostTimeClock()), kCMTimeInvalid};
    CMSampleBufferCreateReadyWithImageBuffer(nullptr, pixels, format, &timing, &sample);
    CFRelease(format);
  }
  CVPixelBufferRelease(pixels);
  if (!sample) {
    [self fail];
    return NO;
  }
  CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sample, true);
  if (!attachments || CFArrayGetCount(attachments) == 0) {
    CFRelease(sample);
    [self fail];
    return NO;
  }
  CFMutableDictionaryRef flags = (CFMutableDictionaryRef)CFArrayGetValueAtIndex(attachments, 0);
  CFDictionarySetValue(flags, kCMSampleAttachmentKey_DisplayImmediately, kCFBooleanTrue);

  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  _video.frame = self.bounds;
  [CATransaction commit];
  if (_firstFrameAt == 0) _firstFrameAt = CACurrentMediaTime();
  [_renderer enqueueSampleBuffer:sample];
  CFRelease(sample);
  return YES;
}

- (BOOL)paintPixels:(CVPixelBufferRef)pixels scale:(CGFloat)scale {
  if (CVPixelBufferLockBaseAddress(pixels, 0) != kCVReturnSuccess) return NO;
  const size_t width = CVPixelBufferGetWidth(pixels);
  const size_t height = CVPixelBufferGetHeight(pixels);
  CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  CGContextRef context = CGBitmapContextCreate(CVPixelBufferGetBaseAddress(pixels),
      width, height, 8, CVPixelBufferGetBytesPerRow(pixels), space,
      kCGBitmapByteOrder32Little | kCGImageAlphaPremultipliedFirst);
  CGColorSpaceRelease(space);
  if (!context) {
    CVPixelBufferUnlockBaseAddress(pixels, 0);
    return NO;
  }

  CGContextSetRGBFillColor(context, 0.084, 0.101, 0.137, 1);
  CGContextFillRect(context, CGRectMake(0, 0, width, height));
  CGContextTranslateCTM(context, 0, height);
  CGContextScaleCTM(context, scale, -scale);
  CGContextSetRGBFillColor(context, 0.45, 0.49, 0.56, 1);
  CGContextFillRect(context, CGRectMake(NSMidX(self.bounds) - 13, 8, 26, 2));
  NSRect area = [self textRect];
  CGContextClipToRect(context, area);

  [NSGraphicsContext saveGraphicsState];
  NSGraphicsContext.currentContext = [NSGraphicsContext graphicsContextWithCGContext:context flipped:YES];
  NSRect visibleText = NSMakeRect(0, _scroll, NSWidth(area), NSHeight(area));
  NSRange glyphs = [_layout glyphRangeForBoundingRect:visibleText inTextContainer:_container];
  [_layout drawGlyphsForGlyphRange:glyphs atPoint:NSMakePoint(NSMinX(area), NSMinY(area) - _scroll)];
  [NSGraphicsContext restoreGraphicsState];
  CGContextRelease(context);
  CVPixelBufferUnlockBaseAddress(pixels, 0);
  return YES;
}
@end

namespace {
napi_value Result(napi_env env, bool ok) {
  napi_value result;
  napi_get_boolean(env, ok, &result);
  return result;
}

NSView* ReadView(napi_env env, napi_value handle) {
  if (!NSThread.isMainThread) return nil;
  bool isBuffer = false;
  if (napi_is_buffer(env, handle, &isBuffer) != napi_ok || !isBuffer) return nil;
  void* data = nullptr;
  size_t size = 0;
  if (napi_get_buffer_info(env, handle, &data, &size) != napi_ok || size < sizeof(void*)) return nil;
  void* pointer = nullptr;
  std::memcpy(&pointer, data, sizeof(pointer));
  return (__bridge NSView*)pointer;
}

NSString* ReadString(napi_env env, napi_value frame, const char* key) {
  napi_value property;
  size_t length = 0;
  if (napi_get_named_property(env, frame, key, &property) != napi_ok ||
      napi_get_value_string_utf16(env, property, nullptr, 0, &length) != napi_ok) return nil;
  std::vector<char16_t> characters(length + 1);
  if (napi_get_value_string_utf16(env, property, characters.data(), characters.size(), &length) != napi_ok) return nil;
  return [NSString stringWithCharacters:reinterpret_cast<const unichar*>(characters.data()) length:length];
}

double ReadNumber(napi_env env, napi_value frame, const char* key, double fallback) {
  napi_value property;
  double value = fallback;
  if (napi_get_named_property(env, frame, key, &property) != napi_ok ||
      napi_get_value_double(env, property, &value) != napi_ok || !std::isfinite(value)) return fallback;
  return value;
}

bool ReadBool(napi_env env, napi_value frame, const char* key) {
  napi_value property;
  bool value = false;
  return napi_get_named_property(env, frame, key, &property) == napi_ok &&
      napi_get_value_bool(env, property, &value) == napi_ok && value;
}

napi_value Update(napi_env env, napi_callback_info info) {
  if (@available(macOS 14.4, *)) {
    size_t argc = 2;
    napi_value argv[2];
    if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 2) {
      return Result(env, false);
    }
    NSView* view = ReadView(env, argv[0]);
    NSView* host = view.window.contentView;
    NSString* text = ReadString(env, argv[1], "text");
    if (!host || text.length == 0) return Result(env, false);

    AceProtectedOverlayView* overlay = objc_getAssociatedObject(view, &kProtectedViewKey);
    if (!overlay) {
      overlay = [[AceProtectedOverlayView alloc] initWithFrame:host.bounds];
      if (!overlay) return Result(env, false);
      [host addSubview:overlay positioned:NSWindowAbove relativeTo:nil];
      objc_setAssociatedObject(view, &kProtectedViewKey, overlay, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    unsigned int rgb = 0xe2e8f0;
    NSString* hex = ReadString(env, argv[1], "fontColor");
    if (hex.length == 7 && [hex hasPrefix:@"#"]) {
      [[NSScanner scannerWithString:[hex substringFromIndex:1]] scanHexInt:&rgb];
    }
    CGFloat fontSize = std::clamp(ReadNumber(env, argv[1], "fontSize", 14), 10.0, 48.0);
    CGFloat opacity = std::clamp(ReadNumber(env, argv[1], "opacity", 0.88), 0.0, 1.0);
    NSColor* color = [NSColor colorWithSRGBRed:((rgb >> 16) & 255) / 255.0
                                        green:((rgb >> 8) & 255) / 255.0
                                         blue:(rgb & 255) / 255.0 alpha:1];
    return Result(env, [overlay updateText:text identifier:ReadString(env, argv[1], "id") ?: @""
                                 fontSize:fontSize textColor:color opacity:opacity
                                streaming:ReadBool(env, argv[1], "streaming")
                                   follow:ReadBool(env, argv[1], "follow")]);
  }
  return Result(env, false);
}

napi_value Clear(napi_env env, napi_callback_info info) {
  if (@available(macOS 14.4, *)) {
    size_t argc = 1;
    napi_value handle;
    if (napi_get_cb_info(env, info, &argc, &handle, nullptr, nullptr) == napi_ok && argc == 1) {
      NSView* view = ReadView(env, handle);
      if (view) {
        AceProtectedOverlayView* overlay = objc_getAssociatedObject(view, &kProtectedViewKey);
        [overlay retire];
        [overlay removeFromSuperview];
        objc_setAssociatedObject(view, &kProtectedViewKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        return Result(env, true);
      }
    }
  }
  return Result(env, false);
}

napi_value IsHealthy(napi_env env, napi_callback_info info) {
  if (@available(macOS 14.4, *)) {
    size_t argc = 1;
    napi_value handle;
    if (napi_get_cb_info(env, info, &argc, &handle, nullptr, nullptr) == napi_ok && argc == 1) {
      NSView* view = ReadView(env, handle);
      if (view) {
        AceProtectedOverlayView* overlay = objc_getAssociatedObject(view, &kProtectedViewKey);
        return Result(env, [overlay isHealthy]);
      }
    }
  }
  return Result(env, false);
}
}

void ExportProtectedOverlay(napi_env env, napi_value exports) {
  const napi_property_descriptor methods[] = {
    {"updateProtectedOverlay", nullptr, Update, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"clearProtectedOverlay", nullptr, Clear, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"isProtectedOverlayHealthy", nullptr, IsHealthy, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
}
