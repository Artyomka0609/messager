# -*- coding: utf-8 -*-
"""Генерация иконок мессенджера (чистый stdlib: zlib + struct).
Пишет app.ico (favicon) и PNG-иконки для сайта/PWA в public/."""
import os, zlib, struct

BASE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(BASE, 'public')
ICO_OUT = os.path.join(BASE, 'app.ico')

TOP = (0x33, 0xB6, 0xF7)
BOT = (0x1F, 0x9F, 0xDE)

# бумажный самолётик — два треугольника (в долях от размера)
A = (0.20, 0.42)
B = (0.80, 0.20)
C = (0.13, 0.76)
B2 = (0.62, 0.86)


def in_tri(px, py, p1, p2, p3):
    def sign(a, b, c):
        return (a[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (a[1] - c[1])
    d1 = sign((px, py), p1, p2)
    d2 = sign((px, py), p2, p3)
    d3 = sign((px, py), p3, p1)
    has_neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    has_pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (has_neg and has_pos)


def in_plane(px, py):
    return in_tri(px, py, A, B, C) or in_tri(px, py, B, B2, C)


def in_rounded(x, y, w, h, r):
    if x < r and y < r:
        return (x - r) ** 2 + (y - r) ** 2 <= r * r
    if x > w - r and y < r:
        return (x - (w - r)) ** 2 + (y - r) ** 2 <= r * r
    if x < r and y > h - r:
        return (x - r) ** 2 + (y - (h - r)) ** 2 <= r * r
    if x > w - r and y > h - r:
        return (x - (w - r)) ** 2 + (y - (h - r)) ** 2 <= r * r
    return 0 <= x <= w and 0 <= y <= h


def sample(cx, cy, w, h, r):
    # сглаживание 2x2
    cov = 0
    plane = 0
    for dx in (0.25, 0.75):
        for dy in (0.25, 0.75):
            x, y = cx + dx, cy + dy
            if in_rounded(x, y, w, h, r):
                cov += 1
                nx, ny = x / w, y / h
                if in_plane(nx, ny):
                    plane += 1
    if cov == 0:
        return (0, 0, 0, 0)
    t = cy / float(h)
    rr = int(TOP[0] + (BOT[0] - TOP[0]) * t)
    gg = int(TOP[1] + (BOT[1] - TOP[1]) * t)
    bb = int(TOP[2] + (BOT[2] - TOP[2]) * t)
    a = int(255 * cov / 4)
    if plane > 0:
        wplane = plane / 4.0
        rr = int(rr * (1 - wplane) + 255 * wplane)
        gg = int(gg * (1 - wplane) + 255 * wplane)
        bb = int(bb * (1 - wplane) + 255 * wplane)
    return (rr, gg, bb, a)


def make_png(size):
    w = h = size
    r = 0.234375 * size
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        for x in range(w):
            raw += bytes(sample(x, y, w, h, r))
    comp = zlib.compress(bytes(raw), 9)

    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', comp) + chunk(b'IEND', b'')


def main():
    png256 = make_png(256)
    header = struct.pack('<HHH', 0, 1, 1)
    entry = bytes([0, 0, 0, 0]) + struct.pack('<HH', 1, 32) + struct.pack('<II', len(png256), 22)
    with open(ICO_OUT, 'wb') as f:
        f.write(header + entry + png256)
    print('OK ->', ICO_OUT, len(png256), 'bytes PNG')

    os.makedirs(PUBLIC, exist_ok=True)
    for size in (180, 192, 512):
        out = os.path.join(PUBLIC, 'icon-%d.png' % size)
        with open(out, 'wb') as f:
            f.write(make_png(size))
        print('OK ->', out)


if __name__ == '__main__':
    main()
