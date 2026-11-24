{
  "targets": [
    {
      "target_name": "capture_guard",
      "sources": ["native/src/capture_guard_stub.cc"],
      "conditions": [
        ["OS=='mac'", {
          "sources!": ["native/src/capture_guard_stub.cc"],
          "sources": ["native/src/capture_guard_mac.mm", "native/src/protected_overlay_mac.mm"],
          "xcode_settings": {
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "OTHER_CFLAGS": ["-fobjc-arc"]
          },
          "libraries": [
            "-framework Cocoa", "-framework QuartzCore", "-framework CoreGraphics",
            "-framework AVFoundation", "-framework CoreMedia", "-framework CoreVideo"
          ]
        }],
        ["OS=='win'", {
          "sources!": ["native/src/capture_guard_stub.cc"],
          "sources": ["native/src/capture_guard_win.cc"],
          "libraries": ["user32.lib"]
        }]
      ]
    }
  ]
}
