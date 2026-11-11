package com.interviewace.overlay;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ServerTargetTest {
    @Test
    public void parsesHttpQrAndBuildsWebSocketUrl() {
        ServerTarget target = ServerTarget.parse(
            "http://192.168.1.20:18080/?mobile=1&mode=ai-interview&t=secret"
        );

        assertEquals("ws://192.168.1.20:18080/ws?token=secret", target.websocketUrl().toString());
        assertEquals("ai-interview", target.mode());
        assertEquals("http://192.168.1.20:18080/", target.displayUrl());
    }

    @Test
    public void parsesHttpsQrAsSecureWebSocket() {
        ServerTarget target = ServerTarget.parse(
            "https://10.0.0.8:19443/?mobile=1&mode=assist"
        );

        assertEquals("wss://10.0.0.8:19443/ws", target.websocketUrl().toString());
        assertEquals("assist", target.mode());
        assertTrue(target.usesTls());
    }

    @Test(expected = IllegalArgumentException.class)
    public void rejectsNonHttpUrl() {
        ServerTarget.parse("file:///tmp/config");
    }
}
