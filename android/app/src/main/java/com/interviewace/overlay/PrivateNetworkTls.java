package com.interviewace.overlay;

import java.net.InetAddress;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.regex.Pattern;

import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

import okhttp3.OkHttpClient;

final class PrivateNetworkTls {
    private static final Pattern IPV4_PRIVATE = Pattern.compile(
        "^(10\\.|127\\.|192\\.168\\.|169\\.254\\.|"
            + "172\\.(1[6-9]|2[0-9]|3[0-1])\\.)"
    );

    private PrivateNetworkTls() {
    }

    static boolean isPrivateHost(String host) {
        if (host == null || host.isEmpty()) return false;
        if ("localhost".equalsIgnoreCase(host)) return true;
        String lower = host.toLowerCase();
        if (lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:")) {
            return true;
        }
        if (IPV4_PRIVATE.matcher(host).find()) return true;
        try {
            InetAddress address = InetAddress.getByName(host);
            return address.isSiteLocalAddress()
                || address.isLoopbackAddress()
                || address.isLinkLocalAddress();
        } catch (Exception ignored) {
            return false;
        }
    }

    static void configureForPrivateSelfSignedHost(OkHttpClient.Builder builder, String host) {
        if (!isPrivateHost(host)) return;
        try {
            TrustManager[] trustManagers = new TrustManager[]{
                new X509TrustManager() {
                    @Override
                    public void checkClientTrusted(X509Certificate[] chain, String authType) {
                    }

                    @Override
                    public void checkServerTrusted(X509Certificate[] chain, String authType) {
                    }

                    @Override
                    public X509Certificate[] getAcceptedIssuers() {
                        return new X509Certificate[0];
                    }
                }
            };
            SSLContext context = SSLContext.getInstance("TLS");
            context.init(null, trustManagers, new SecureRandom());
            builder.sslSocketFactory(context.getSocketFactory(), (X509TrustManager) trustManagers[0]);
            builder.hostnameVerifier((requestedHost, session) -> isPrivateHost(requestedHost));
        } catch (Exception ignored) {
            // Fall back to the platform trust store if TLS initialization fails.
        }
    }
}
