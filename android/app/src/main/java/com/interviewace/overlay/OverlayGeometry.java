package com.interviewace.overlay;

final class OverlayGeometry {
    static final int CORNER_TOP_LEFT = 0;
    static final int CORNER_TOP_RIGHT = 1;
    static final int CORNER_BOTTOM_LEFT = 2;
    static final int CORNER_BOTTOM_RIGHT = 3;

    private OverlayGeometry() {
    }

    static Bounds resize(
        int startX,
        int startY,
        int startWidth,
        int startHeight,
        int deltaX,
        int deltaY,
        int corner,
        int minWidth,
        int minHeight,
        int maxWidth,
        int maxHeight
    ) {
        int width = startWidth;
        int height = startHeight;
        int x = startX;
        int y = startY;

        boolean left = corner == CORNER_TOP_LEFT || corner == CORNER_BOTTOM_LEFT;
        boolean top = corner == CORNER_TOP_LEFT || corner == CORNER_TOP_RIGHT;

        width = clamp(left ? startWidth - deltaX : startWidth + deltaX, minWidth, maxWidth);
        height = clamp(top ? startHeight - deltaY : startHeight + deltaY, minHeight, maxHeight);
        if (left) x = startX + (startWidth - width);
        if (top) y = startY + (startHeight - height);

        return new Bounds(x, y, width, height);
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }

    static final class Bounds {
        final int x;
        final int y;
        final int width;
        final int height;

        Bounds(int x, int y, int width, int height) {
            this.x = x;
            this.y = y;
            this.width = width;
            this.height = height;
        }
    }
}
