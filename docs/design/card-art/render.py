"""Render the Discord card art (thumbnail + banner strips) from the brand assets.

Inputs (unchanged, byte-exact): packages/dashboard/public/brand/brand-mark.jpg,
packages/dashboard/public/brand/bananasaur.png. The banana-leaf crown is redrawn
from the path data in packages/dashboard/public/brand/leaves.svg (same Bezier
control points), because no SVG rasteriser is a project dependency.

Outputs: apps/daemon/assets/cards/*.png. Run from the repository root:

    python3 -I docs/design/card-art/render.py

Reproducible: no randomness; re-running overwrites the outputs identically.
"""

from __future__ import annotations

import math
import pathlib
import sys

from PIL import Image, ImageDraw

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '.').resolve()
BRAND = ROOT / 'packages/dashboard/public/brand'
OUT = ROOT / 'apps/daemon/assets/cards'
SS = 3  # supersampling factor for anti-aliased vector drawing

# --- tiny vector helpers ------------------------------------------------------


def cubic(p0, p1, p2, p3, steps=24):
    pts = []
    for i in range(steps + 1):
        t = i / steps
        mt = 1 - t
        x = mt**3 * p0[0] + 3 * mt**2 * t * p1[0] + 3 * mt * t**2 * p2[0] + t**3 * p3[0]
        y = mt**3 * p0[1] + 3 * mt**2 * t * p1[1] + 3 * mt * t**2 * p2[1] + t**3 * p3[1]
        pts.append((x, y))
    return pts


def path(start, segments):
    """segments: list of ('C', c1, c2, end) or ('L', end)."""
    pts = [start]
    cur = start
    for seg in segments:
        if seg[0] == 'C':
            pts.extend(cubic(cur, seg[1], seg[2], seg[3])[1:])
            cur = seg[3]
        else:
            pts.append(seg[1])
            cur = seg[1]
    return pts


def transform(pts, tx=0.0, ty=0.0, rot_deg=0.0, scale=1.0):
    r = math.radians(rot_deg)
    c, s = math.cos(r), math.sin(r)
    return [(tx + scale * (x * c - y * s), ty + scale * (x * s + y * c)) for x, y in pts]


BLADE = path(
    (0, 0),
    [
        ('C', (90, -34), (200, -40), (300, -8)),
        ('C', (340, 5), (372, 24), (392, 48)),
        ('C', (330, 66), (210, 78), (110, 58)),
        ('C', (62, 48), (22, 26), (0, 0)),
    ],
)
RIB = cubic((6, 4), (120, 12), (260, 22), (386, 46))
STEM = path(
    (-40, 470),
    [
        ('C', (40, 480), (96, 520), (128, 590)),
        ('C', (150, 640), (156, 700), (150, 770)),
        ('L', (60, 800)),
        ('C', (60, 700), (30, 600), (-40, 540)),
    ],
)
OUTLINE = (34, 57, 29, 255)


def hexa(h, a=255):
    h = h.lstrip('#')
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)


def draw_leaves(size, alpha=1.0):
    """The leaves.svg crown on a transparent 460x900 canvas, returned at `size` height."""
    w, h = 460 * SS, 900 * SS
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def poly(pts, fill, op=1.0):
        layer = Image.new('RGBA', (w, h), (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        sc = [(x * SS, y * SS) for x, y in pts]
        f = fill[:3] + (int(fill[3] * op * alpha),)
        o = OUTLINE[:3] + (int(255 * op * alpha),)
        ld.polygon(sc, fill=f)
        ld.line(sc + [sc[0]], fill=o, width=7 * SS, joint='curve')
        img.alpha_composite(layer)

    def rib(tx, ty, rot, scale, op=1.0):
        layer = Image.new('RGBA', (w, h), (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        sc = [(x * SS, y * SS) for x, y in transform(RIB, tx, ty, rot, scale)]
        ld.line(sc, fill=OUTLINE[:3] + (int(140 * op * alpha),), width=5 * SS, joint='curve')
        img.alpha_composite(layer)

    poly(STEM, hexa('#4d7f40'))
    blades = [
        (60, 330, -38, 1.06, '#3e6b34', 1.0),
        (70, 480, -6, 1.15, '#4d7f40', 1.0),
        (66, 620, 30, 0.98, '#3e6b34', 0.92),
        (40, 210, -64, 0.72, '#5c8f4c', 0.85),
    ]
    for tx, ty, rot, scale, fill, op in blades:
        poly(transform(BLADE, tx, ty, rot, scale), hexa(fill), op)
        rib(tx, ty, rot, scale, op)
    del d
    out_h = size
    out_w = round(460 * out_h / 900)
    return img.resize((out_w, out_h), Image.LANCZOS)


def radial(size, inner, mid, outer, cx=0.8, cy=1.0):
    w, h = size
    img = Image.new('RGBA', size)
    px = img.load()
    a, b, c = hexa(inner), hexa(mid), hexa(outer)
    for y in range(h):
        for x in range(w):
            dx = (x / w - cx) / 1.2
            dy = (y / h - cy) / 1.4
            t = min(1.0, math.hypot(dx, dy))
            if t < 0.45:
                k = t / 0.45
                col = tuple(round(a[i] + (b[i] - a[i]) * k) for i in range(4))
            else:
                k = (t - 0.45) / 0.55
                col = tuple(round(b[i] + (c[i] - b[i]) * k) for i in range(4))
            px[x, y] = col
    return img


def footprints(size, colour, alpha):
    w, h = size
    img = Image.new('RGBA', (w * SS, h * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    fill = hexa(colour, alpha)
    step = w * SS / 4.2
    for i in range(4):
        ox = i * step + 10 * SS
        oy = (h * SS * 0.62) if i % 2 == 0 else (h * SS * 0.30)
        d.ellipse([ox, oy, ox + 24 * SS, oy + 18 * SS], fill=fill)
        for j, (dx, dy) in enumerate([(-6, -10), (6, -14), (18, -10)]):
            cxp, cyp = ox + (dx + 6) * SS, oy + dy * SS
            d.ellipse([cxp - 4 * SS, cyp - 4 * SS, cxp + 4 * SS, cyp + 4 * SS], fill=fill)
    return img.resize((w, h), Image.LANCZOS)


VARIANTS = {
    # name: (inner, mid, outer, leaf alpha, footprint colour, footprint alpha)
    'banner-tasks': ('#FFE58A', '#FFF3C4', '#FFFBEA', 1.0, '#14213D', 26),
    'banner-digest': ('#CFE7B8', '#E6F2D8', '#F5FAEF', 1.0, '#14213D', 26),
    'banner-panel': ('#2B4C9B', '#1C2F63', '#14213D', 0.55, '#FFFFFF', 22),
}


def banner(name, spec):
    W, H = 1200, 240
    inner, mid, outer, leaf_alpha, fp_col, fp_alpha = spec
    img = radial((W, H), inner, mid, outer)
    leaves = draw_leaves(int(H * 2.2), leaf_alpha).rotate(12, expand=True, resample=Image.BICUBIC)
    img.alpha_composite(leaves, (-int(W * 0.03), -int(H * 0.75)))
    fp = footprints((int(W * 0.34), int(H * 0.36)), fp_col, fp_alpha)
    img.alpha_composite(fp, (int(W * 0.30), int(H * 0.56)))
    saur = Image.open(BRAND / 'bananasaur.png').convert('RGBA')
    sh = int(H * 0.98)
    saur = saur.resize((round(saur.width * sh / saur.height), sh), Image.LANCZOS)
    img.alpha_composite(saur, (W - saur.width - int(W * 0.04), H - sh - int(H * 0.01)))
    out = img.convert('RGB').quantize(colors=160, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG)
    out.save(OUT / f'{name}.png', optimize=True)


def thumbnail():
    mark = Image.open(BRAND / 'brand-mark.jpg').convert('RGB').resize((160, 160), Image.LANCZOS)
    mark.quantize(colors=96, method=Image.Quantize.MEDIANCUT).save(
        OUT / 'saur-thumb.png', optimize=True
    )


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    thumbnail()
    for name, spec in VARIANTS.items():
        banner(name, spec)
    for p in sorted(OUT.glob('*.png')):
        print(p.relative_to(ROOT), p.stat().st_size, Image.open(p).size)


if __name__ == '__main__':
    main()
