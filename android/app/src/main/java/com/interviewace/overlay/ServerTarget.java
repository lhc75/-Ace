package com.interviewace.overlay;

import androidx.annotation.NonNull;

import okhttp3.HttpUrl;

public final class ServerTarget {
    private final HttpUrl pageUrl;
    private final String websocketUrl;
    private final String mode;

    private ServerTarget(HttpUrl pageUrl, String websocketUrl, String mode) {
        this.pageUrl = pageUrl;
        this.websocketUrl = websocketUrl;
        this.mode = mode;
    }

    public static ServerTarget parse(String raw) {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty()) {
            throw new IllegalArgumentException("二维码中没有连接地址");
        }
        HttpUrl pageUrl = HttpUrl.parse(value);
        if (pageUrl == null) {
            throw new IllegalArgumentException("二维码不是有效的网址");
        }
        String scheme = pageUrl.scheme();
        if (!"http".equals(scheme) && !"https".equals(scheme)) {
            throw new IllegalArgumentException("仅支持面试Ace的 HTTP/HTTPS 地址");
        }

        String requestedMode = pageUrl.queryParameter("mode");
        String mode = "assist".equals(requestedMode) ? "assist" : "ai-interview";
        String token = pageUrl.queryParameter("t");
        if (token == null || token.isEmpty()) {
            token = pageUrl.queryParameter("token");
        }

        HttpUrl.Builder wsBuilder = pageUrl.newBuilder()
            .scheme("http")
            .encodedPath("/ws")
            .query(null)
            .fragment(null);
        if (token != null && !token.isEmpty()) {
            wsBuilder.addQueryParameter("token", token);
        }
        String httpWebSocket = wsBuilder.build().toString();
        String websocketUrl = ("https".equals(scheme) ? "wss" : "ws")
            + httpWebSocket.substring("http".length());
        return new ServerTarget(pageUrl, websocketUrl, mode);
    }

    public HttpUrl pageUrl() {
        return pageUrl;
    }

    public String websocketUrl() {
        return websocketUrl;
    }

    public String mode() {
        return mode;
    }

    public boolean usesTls() {
        return websocketUrl.startsWith("wss://");
    }

    public String host() {
        return pageUrl.host();
    }

    public String displayUrl() {
        return pageUrl.newBuilder()
            .query(null)
            .fragment(null)
            .build()
            .toString();
    }

    @NonNull
    @Override
    public String toString() {
        return displayUrl();
    }
}
