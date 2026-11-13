#include <node_api.h>

#import <Cocoa/Cocoa.h>
#include <CoreGraphics/CoreGraphics.h>
#include <dlfcn.h>
#include <string.h>

// Chromium uses this private WindowServer API for screenshot protection on
// current macOS releases. NSWindow.sharingType is ignored by ScreenCaptureKit,
// while CGSSetWindowCaptureExcludeShape is the capture-exclusion path used by
// Chromium's own content-protection implementation.
typedef uint32_t CGSConnectionID;
typedef CFTypeRef CGRegionRef;
typedef CGSConnectionID (*CGSMainConnectionIDFn)(void);
typedef CGError (*CGSSetWindowCaptureExcludeShapeFn)(
    CGSConnectionID connection,
    CGWindowID window_id,
    CGRegionRef region);
typedef CGRegionRef (*CGRegionCreateWithRectFn)(CGRect rect);

namespace {

bool ReadWindowHandle(napi_env env, napi_value value, NSView** out_view, const char** error) {
  bool is_buffer = false;
  napi_is_buffer(env, value, &is_buffer);
  if (!is_buffer) {
    *error = "native window handle must be a Buffer";
    return false;
  }

  void* data = nullptr;
  size_t length = 0;
  napi_get_buffer_info(env, value, &data, &length);
  if (!data || length < sizeof(void*)) {
    *error = "native window handle is invalid";
    return false;
  }

  uintptr_t raw = 0;
  memcpy(&raw, data, sizeof(void*));
  *out_view = (__bridge NSView*)(void*)raw;
  if (!*out_view) {
    *error = "native window handle is null";
    return false;
  }
  return true;
}

bool ReadExcludeFlag(napi_env env, size_t argc, napi_value* argv, bool* out_exclude) {
  *out_exclude = true;
  if (argc < 2) return true;
  napi_valuetype type;
  napi_typeof(env, argv[1], &type);
  if (type != napi_boolean) return false;
  napi_get_value_bool(env, argv[1], out_exclude);
  return true;
}

napi_value SetResult(napi_env env, bool ok, bool supported, const char* error) {
  napi_value result;
  napi_create_object(env, &result);

  napi_value value;
  napi_get_boolean(env, ok, &value);
  napi_set_named_property(env, result, "ok", value);
  napi_get_boolean(env, supported, &value);
  napi_set_named_property(env, result, "supported", value);

  if (error) {
    napi_create_string_utf8(env, error, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, result, "error", value);
  }
  return result;
}

napi_value SetCaptureExclusion(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  if (argc < 1) {
    napi_throw_type_error(env, nullptr, "native window handle required");
    return nullptr;
  }

  bool exclude = true;
  if (!ReadExcludeFlag(env, argc, argv, &exclude)) {
    napi_throw_type_error(env, nullptr, "exclude flag must be a boolean");
    return nullptr;
  }

  NSView* view = nil;
  const char* handle_error = nullptr;
  if (!ReadWindowHandle(env, argv[0], &view, &handle_error)) {
    napi_throw_type_error(env, nullptr, handle_error);
    return nullptr;
  }

  NSWindow* window = view.window;
  if (!window || window.windowNumber <= 0) {
    return SetResult(env, false, true, "NSView has no active NSWindow");
  }

  void* skylight = dlopen(
      "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight",
      RTLD_LAZY | RTLD_LOCAL);
  if (!skylight) {
    return SetResult(env, false, false, "SkyLight framework unavailable");
  }

  auto get_connection =
      (CGSMainConnectionIDFn)dlsym(skylight, "CGSMainConnectionID");
  auto set_exclude_shape =
      (CGSSetWindowCaptureExcludeShapeFn)dlsym(
          skylight, "CGSSetWindowCaptureExcludeShape");
  auto create_region =
      (CGRegionCreateWithRectFn)dlsym(skylight, "CGRegionCreateWithRect");
  if (!get_connection || !set_exclude_shape || !create_region) {
    return SetResult(env, false, false, "CGS capture exclusion API unavailable");
  }

  CGRegionRef region = nullptr;
  if (exclude) {
    NSRect frame = window.frame;
    region = create_region(CGRectMake(0, 0, frame.size.width, frame.size.height));
    if (!region) {
      return SetResult(env, false, true, "failed to create capture exclusion region");
    }
  }

  CGError code = set_exclude_shape(get_connection(), (CGWindowID)window.windowNumber, region);
  if (region) CFRelease(region);

  if (code != kCGErrorSuccess) {
    return SetResult(env, false, true, "CGSSetWindowCaptureExcludeShape failed");
  }
  return SetResult(env, true, true, nullptr);
}

napi_value Init(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(
      env, "setCaptureExclusion", NAPI_AUTO_LENGTH, SetCaptureExclusion, nullptr, &function);
  napi_set_named_property(env, exports, "setCaptureExclusion", function);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
