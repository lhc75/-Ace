#define NOMINMAX
#include <windows.h>
#include <node_api.h>

#include <cstring>
#include <string>

#ifndef WDA_EXCLUDEFROMCAPTURE
#define WDA_EXCLUDEFROMCAPTURE 0x00000011
#endif

namespace {

bool ReadWindowHandle(napi_env env, napi_value value, HWND* out_window, const char** error) {
  bool is_buffer = false;
  napi_is_buffer(env, value, &is_buffer);
  if (!is_buffer) {
    *error = "native window handle must be a Buffer";
    return false;
  }

  void* data = nullptr;
  size_t length = 0;
  napi_get_buffer_info(env, value, &data, &length);
  if (!data || length < sizeof(HWND)) {
    *error = "native window handle is invalid";
    return false;
  }

  std::memcpy(out_window, data, sizeof(HWND));
  if (!*out_window) {
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

void ApplyCaptureExclusion(HWND window, bool exclude) {
  DWORD current = WDA_NONE;
  if (::GetWindowDisplayAffinity(window, &current)) {
    const DWORD desired = exclude ? WDA_EXCLUDEFROMCAPTURE : WDA_NONE;
    if (current == desired) return;
  }
  ::SetWindowDisplayAffinity(window, exclude ? WDA_EXCLUDEFROMCAPTURE : WDA_NONE);
}

bool ApplyClickThroughStyle(HWND window, bool enabled, DWORD* out_error) {
  ::SetLastError(ERROR_SUCCESS);
  LONG_PTR style = ::GetWindowLongPtrW(window, GWL_EXSTYLE);
  if (style == 0 && ::GetLastError() != ERROR_SUCCESS) {
    *out_error = ::GetLastError();
    return false;
  }

  // Transparent Electron windows are layered already. Keep LAYERED while only
  // toggling WS_EX_TRANSPARENT so mouse passing can be changed without
  // destroying the transparent rendering surface.
  LONG_PTR next = style | WS_EX_LAYERED;
  if (enabled) {
    next |= WS_EX_TRANSPARENT;
  } else {
    next &= ~WS_EX_TRANSPARENT;
  }

  if (next != style) {
    ::SetLastError(ERROR_SUCCESS);
    if (!::SetWindowLongPtrW(window, GWL_EXSTYLE, next)) {
      *out_error = ::GetLastError();
      return false;
    }
  }
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

  HWND window = nullptr;
  const char* handle_error = nullptr;
  if (!ReadWindowHandle(env, argv[0], &window, &handle_error)) {
    napi_throw_type_error(env, nullptr, handle_error);
    return nullptr;
  }

  DWORD affinity = exclude ? WDA_EXCLUDEFROMCAPTURE : WDA_NONE;
  if (!SetWindowDisplayAffinity(window, affinity)) {
    std::string message = "SetWindowDisplayAffinity failed (";
    message += std::to_string(GetLastError());
    message += ")";
    return SetResult(env, false, true, message.c_str());
  }
  return SetResult(env, true, true, nullptr);
}

napi_value SetClickThrough(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  if (argc < 1) {
    napi_throw_type_error(env, nullptr, "native window handle required");
    return nullptr;
  }

  bool enabled = true;
  if (!ReadExcludeFlag(env, argc, argv, &enabled)) {
    napi_throw_type_error(env, nullptr, "click-through flag must be a boolean");
    return nullptr;
  }

  HWND window = nullptr;
  const char* handle_error = nullptr;
  if (!ReadWindowHandle(env, argv[0], &window, &handle_error)) {
    napi_throw_type_error(env, nullptr, handle_error);
    return nullptr;
  }

  DWORD style_error = ERROR_SUCCESS;
  if (!ApplyClickThroughStyle(window, enabled, &style_error)) {
    std::string message = "SetWindowLongPtr failed (";
    message += std::to_string(style_error);
    message += ")";
    return SetResult(env, false, true, message.c_str());
  }

  // A style change may cause Windows/DWM to revisit display affinity. Reapply
  // capture exclusion after every transition so click-through never makes the
  // window visible to screen sharing.
  ApplyCaptureExclusion(window, true);
  DWORD affinity = WDA_NONE;
  ::GetWindowDisplayAffinity(window, &affinity);
  if (affinity != WDA_EXCLUDEFROMCAPTURE) {
    return SetResult(env, false, true, "capture exclusion was not retained");
  }

  return SetResult(env, true, true, nullptr);
}

napi_value GetCaptureState(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1) {
    napi_throw_type_error(env, nullptr, "native window handle required");
    return nullptr;
  }

  HWND window = nullptr;
  const char* handle_error = nullptr;
  if (!ReadWindowHandle(env, argv[0], &window, &handle_error)) {
    napi_throw_type_error(env, nullptr, handle_error);
    return nullptr;
  }

  DWORD affinity = WDA_NONE;
  const bool affinity_ok = ::GetWindowDisplayAffinity(window, &affinity) != 0;
  const LONG_PTR style = ::GetWindowLongPtrW(window, GWL_EXSTYLE);

  napi_value result;
  napi_create_object(env, &result);
  napi_value value;
  napi_get_boolean(env, affinity_ok && affinity == WDA_EXCLUDEFROMCAPTURE, &value);
  napi_set_named_property(env, result, "captureExcluded", value);
  napi_get_boolean(env, (style & WS_EX_TRANSPARENT) != 0, &value);
  napi_set_named_property(env, result, "clickThrough", value);
  napi_get_boolean(env, (style & WS_EX_LAYERED) != 0, &value);
  napi_set_named_property(env, result, "layered", value);
  napi_create_uint32(env, affinity, &value);
  napi_set_named_property(env, result, "affinity", value);
  return result;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(
      env, "setCaptureExclusion", NAPI_AUTO_LENGTH, SetCaptureExclusion, nullptr, &function);
  napi_set_named_property(env, exports, "setCaptureExclusion", function);

  napi_create_function(
      env, "setClickThrough", NAPI_AUTO_LENGTH, SetClickThrough, nullptr, &function);
  napi_set_named_property(env, exports, "setClickThrough", function);

  napi_create_function(
      env, "getCaptureState", NAPI_AUTO_LENGTH, GetCaptureState, nullptr, &function);
  napi_set_named_property(env, exports, "getCaptureState", function);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
