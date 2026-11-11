package com.interviewace.overlay;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class OverlayGeometryTest {
    @Test
    public void bottomRightResizeKeepsTopLeftFixed() {
        OverlayGeometry.Bounds bounds = OverlayGeometry.resize(
            100, 200, 600, 400, 80, 50,
            OverlayGeometry.CORNER_BOTTOM_RIGHT, 280, 220, 1000, 900
        );

        assertEquals(100, bounds.x);
        assertEquals(200, bounds.y);
        assertEquals(680, bounds.width);
        assertEquals(450, bounds.height);
    }

    @Test
    public void topLeftResizeKeepsBottomRightFixed() {
        OverlayGeometry.Bounds bounds = OverlayGeometry.resize(
            100, 200, 600, 400, 80, 50,
            OverlayGeometry.CORNER_TOP_LEFT, 280, 220, 1000, 900
        );

        assertEquals(180, bounds.x);
        assertEquals(250, bounds.y);
        assertEquals(520, bounds.width);
        assertEquals(350, bounds.height);
    }

    @Test
    public void topRightResizeRespectsMinimumSize() {
        OverlayGeometry.Bounds bounds = OverlayGeometry.resize(
            100, 200, 320, 260, -200, 200,
            OverlayGeometry.CORNER_TOP_RIGHT, 280, 220, 1000, 900
        );

        assertEquals(100, bounds.x);
        assertEquals(240, bounds.y);
        assertEquals(280, bounds.width);
        assertEquals(220, bounds.height);
    }
}
