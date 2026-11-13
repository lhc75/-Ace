#include <node_api.h>

namespace {

napi_value SetCaptureExclusion(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value result;
  napi_create_object(env, &result);

  napi_value value;
  napi_get_boolean(env, false, &value);
  napi_set_named_property(env, result, "ok", value);
  napi_set_named_property(env, result, "supported", value);
  napi_create_string_utf8(
      env, "native capture exclusion is not available on this platform",
      NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, result, "error", value);
  return result;
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
