"""Render the bounded.tools mark at any size. Pure stdlib: no rasteriser here.

Geometry recovered pixel-by-pixel from brand/favicon-32.png (the only asset the
site publishes, and 32px is far too small for a home screen). Reproduced as
shapes rather than upscaled, so 180 and 512 are crisp instead of a blurred 32.
"""
import zlib, struct, math

GREEN = (12, 90, 66)          # #0C5A42 — desk's existing theme_color
WHITE = (255, 255, 255)
SS = 4                        # supersample factor

def rrect_cover(px, py, x, y, w, h, r):
    """Coverage test for a rounded rect: inside → True."""
    cx = min(max(px, x + r), x + w - r)
    cy = min(max(py, y + r), y + h - r)
    dx, dy = px - cx, py - cy
    if px < x or px > x + w or py < y or py > y + h:
        return False
    if (px < x + r or px > x + w - r) and (py < y + r or py > y + h - r):
        return dx * dx + dy * dy <= r * r
    return True

def render(size):
    s = size * SS
    u = s / 32.0                       # one unit = one pixel of the 32px original
    acc = [[[0, 0, 0, 0] for _ in range(s)] for _ in range(s)]
    for j in range(s):
        for i in range(s):
            px, py = (i + 0.5) / u, (j + 0.5) / u
            # FULL-BLEED, opaque, square. The source favicon rounds its own
            # corners, but every home screen masks the icon itself — iOS with a
            # squircle, Android with whatever the launcher picks — so a
            # pre-rounded icon gets rounded twice and shows pale corners inside
            # the mask. Bleed to the edge and let the platform cut the shape.
            # The glyph sits in the middle 50%, comfortably inside the maskable
            # safe zone (the inner 80%), so no mask can clip it.
            col = GREEN
            # the door outline: inside the outer ring but not the inner one
            outer = rrect_cover(px, py, 8.2, 8.2, 15.6, 15.6, 4.6)
            inner = rrect_cover(px, py, 9.6, 9.6, 12.8, 12.8, 3.4)
            if outer and not inner:
                col = WHITE
            # the handle
            if rrect_cover(px, py, 14.8, 15.7, 2.0, 3.6, 1.0):
                col = WHITE
            acc[j][i] = [col[0], col[1], col[2], 255]
    # downsample
    out = bytearray()
    for y in range(size):
        out.append(0)
        for x in range(size):
            r = g = b = a = 0
            for dy in range(SS):
                for dx in range(SS):
                    p = acc[y * SS + dy][x * SS + dx]
                    r += p[0] * p[3]; g += p[1] * p[3]; b += p[2] * p[3]; a += p[3]
            n = SS * SS
            if a:
                out += bytes((r // a, g // a, b // a, a // n))
            else:
                out += b"\0\0\0\0"
    return bytes(out)

def png(size, raw):
    def chunk(t, d):
        c = t + d
        return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))

import sys
for size in (180, 192, 512):
    data = png(size, render(size))
    open(f"/home/user/desk/brand/icon-{size}.png", "wb").write(data)
    print(f"  icon-{size}.png  {len(data)} bytes")
