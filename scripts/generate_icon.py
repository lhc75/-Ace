#!/usr/bin/env python3
"""生成「面试Ace」应用图标: 黛青→荧光青渐变圆角方块 + 白色 A 字声波标。

用法: python3 scripts/generate_icon.py
产出: desktop/icon.png (1024), desktop/icon.icns (macOS), frontend/public/icon.png (256)
依赖: Pillow; iconutil (仅 macOS, 生成 .icns 时调用)。
"""
from __future__ import annotations

import math
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SIZE = 1024  # 主渲染尺寸

COLOR_A = (14, 124, 107)    # 黛青 #0E7C6B
COLOR_B = (45, 212, 191)    # 荧光青 #2DD4BF


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def make_gradient(size: int) -> Image.Image:
    """对角线线性渐变 (左上 COLOR_A → 右下 COLOR_B), 加轻微径向提亮。"""
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            # 中心轻微提亮, 避免纯色渐变发闷
            cx, cy = (x - size * 0.32) / size, (y - size * 0.28) / size
            glow = max(0.0, 1.0 - math.sqrt(cx * cx + cy * cy) * 1.6) * 0.10
            r = min(255, int(lerp(COLOR_A[0], COLOR_B[0], t) + 255 * glow * 0.35))
            g = min(255, int(lerp(COLOR_A[1], COLOR_B[1], t) + 255 * glow * 0.55))
            b = min(255, int(lerp(COLOR_A[2], COLOR_B[2], t) + 255 * glow * 0.5))
            px[x, y] = (r, g, b)
    return img


def rounded_rect_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def thick_line(d: ImageDraw.ImageDraw, p1: tuple, p2: tuple, width: int, fill) -> None:
    """带圆头的粗线。"""
    d.line([p1, p2], width=width, fill=fill)
    r = width / 2
    for p in (p1, p2):
        d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=fill)


def rounded_bar(d: ImageDraw.ImageDraw, cx: float, cy: float, w: float, h: float, fill) -> None:
    d.rounded_rectangle([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], radius=w / 2, fill=fill)


def render_icon(size: int) -> Image.Image:
    S = 4  # 超采样抗锯齿
    big = size * S
    base = make_gradient(big)
    mask = rounded_rect_mask(big, int(big * 0.225))

    layer = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    white = (255, 255, 255, 255)
    u = big / 32.0  # 以 32x32 viewBox 为单位, 与 BrandMark SVG 同构

    # A 字两腿
    w = 3.0 * u
    thick_line(d, (9.5 * u, 25 * u), (16 * u, 7 * u), int(w), white)
    thick_line(d, (16 * u, 7 * u), (22.5 * u, 25 * u), int(w), white)
    # 声波横杠 (位于两腿之间的空隙: y≈18.5 时腿在 x≈12.9 / 19.1)
    rounded_bar(d, 14.3 * u, 18.6 * u, 1.5 * u, 1.7 * u, white)
    rounded_bar(d, 16.0 * u, 18.2 * u, 1.5 * u, 2.9 * u, white)
    rounded_bar(d, 17.7 * u, 18.6 * u, 1.5 * u, 1.7 * u, white)

    out = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    out.paste(base, (0, 0), mask)
    out = Image.alpha_composite(out, layer)
    return out.resize((size, size), Image.LANCZOS)


def main() -> None:
    icon = render_icon(SIZE)

    desktop_png = ROOT / "desktop" / "icon.png"
    icon.save(desktop_png)
    print("written", desktop_png)

    public_png = ROOT / "frontend" / "public" / "icon.png"
    icon.resize((256, 256), Image.LANCZOS).save(public_png)
    print("written", public_png)

    if sys.platform == "darwin" and shutil.which("iconutil"):
        with tempfile.TemporaryDirectory() as td:
            iconset = Path(td) / "icon.iconset"
            iconset.mkdir()
            for edge in (16, 32, 128, 256, 512):
                icon.resize((edge, edge), Image.LANCZOS).save(iconset / f"icon_{edge}x{edge}.png")
                icon.resize((edge * 2, edge * 2), Image.LANCZOS).save(
                    iconset / f"icon_{edge}x{edge}@2x.png"
                )
            out = ROOT / "desktop" / "icon.icns"
            subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(out)], check=True)
            print("written", out)
    else:
        print("skip icon.icns (需要 macOS iconutil)")


if __name__ == "__main__":
    main()
