#!/usr/bin/env python3
"""Generate app icons (PNG, no external deps) for the Sleep Cycle PWA.

Draws a crescent moon on a rounded indigo gradient tile. Pure stdlib
(zlib + struct) PNG encoder, so it runs anywhere Python 3 is available.
"""
import math
import struct
import zlib
import os

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "icons")


def lerp(a, b, t):
    return a + (b - a) * t


def draw(size):
    # palette
    top = (99, 102, 241)      # indigo-500
    bottom = (12, 16, 32)     # near-black navy
    moon = (245, 246, 255)
    star = (199, 210, 254)

    r = size * 0.22           # corner radius
    cx, cy = size * 0.52, size * 0.46
    moon_r = size * 0.30
    # offset circle that carves the crescent
    ox, oy = cx + moon_r * 0.55, cy - moon_r * 0.25
    moon_inner = moon_r * 0.92

    stars = [(0.74, 0.30, 0.018), (0.80, 0.46, 0.012), (0.68, 0.20, 0.010)]

    px = bytearray()
    for y in range(size):
        px.append(0)  # PNG filter type 0 for each row
        for x in range(size):
            # rounded-rect mask (anti-aliased via corner distance)
            inside = True
            dx = min(x - r, 0) if x < r else (x - (size - 1 - r) if x > size - 1 - r else 0)
            dy = min(y - r, 0) if y < r else (y - (size - 1 - r) if y > size - 1 - r else 0)
            if dx or dy:
                if math.hypot(dx, dy) > r:
                    inside = False
            if not inside:
                px.extend((0, 0, 0, 0))
                continue

            t = y / (size - 1)
            R = int(lerp(top[0], bottom[0], t))
            G = int(lerp(top[1], bottom[1], t))
            B = int(lerp(top[2], bottom[2], t))

            # stars
            for sxr, syr, srr in stars:
                if math.hypot(x - sxr * size, y - syr * size) <= srr * size:
                    R, G, B = star

            # crescent moon = inside main circle AND outside offset circle
            d_main = math.hypot(x - cx, y - cy)
            d_off = math.hypot(x - ox, y - oy)
            if d_main <= moon_inner and d_off > moon_r * 0.78:
                # soft edge
                edge = min(moon_inner - d_main, d_off - moon_r * 0.78)
                a = max(0.0, min(1.0, edge / 2.0))
                R = int(lerp(R, moon[0], a))
                G = int(lerp(G, moon[1], a))
                B = int(lerp(B, moon[2], a))

            px.extend((R, G, B, 255))
    return bytes(px)


def write_png(path, size, raw):
    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data +
                struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff))

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    idat = zlib.compress(raw, 9)
    with open(path, "wb") as f:
        f.write(sig)
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", idat))
        f.write(chunk(b"IEND", b""))


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for name, size in [("icon-192.png", 192), ("icon-512.png", 512),
                       ("apple-touch-icon.png", 180)]:
        raw = draw(size)
        write_png(os.path.join(OUT_DIR, name), size, raw)
        print("wrote", name)


if __name__ == "__main__":
    main()
