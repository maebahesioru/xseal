#!/usr/bin/env python3
"""xseal のアイコンを生成する（16/32/48/128）。"""
from PIL import Image, ImageDraw

ACC = (29, 155, 240, 255)
DARK = (8, 11, 16, 255)


def rounded(size, radius_ratio=0.22, bg=DARK):
    scale = 8
    S = size * scale
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = int(S * radius_ratio)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=bg)
    return img, d, S


def draw_lock(img, d, S):
    """シャックル（輪）→ 本体 → 鍵穴 の順に描いて重なりを隠す。"""
    w = S
    bw, bh = int(w * 0.52), int(w * 0.36)
    x0 = (w - bw) // 2
    y0 = int(w * 0.47)

    # シャックル: 太い輪を描き、下端を本体で隠す
    sw = int(w * 0.34)
    sx0 = (w - sw) // 2
    sy0 = int(w * 0.22)
    sy1 = y0 + int(w * 0.10)
    thick = max(2, int(w * 0.085))
    d.rounded_rectangle([sx0, sy0, sx0 + sw, sy1], radius=sw // 2, outline=ACC, width=thick)

    # 本体
    d.rounded_rectangle([x0, y0, x0 + bw, y0 + bh], radius=int(bw * 0.20), fill=ACC)

    # 鍵穴
    kr = int(w * 0.058)
    cx = w // 2
    cy = y0 + int(bh * 0.40)
    d.ellipse([cx - kr, cy - kr, cx + kr, cy + kr], fill=DARK)
    d.polygon([(cx - int(kr * 0.42), cy), (cx + int(kr * 0.42), cy),
               (cx + int(kr * 0.26), cy + int(kr * 2.0)),
               (cx - int(kr * 0.26), cy + int(kr * 2.0))], fill=DARK)


def make(size, path):
    img, d, S = rounded(size)
    draw_lock(img, d, S)
    img = img.resize((size, size), Image.LANCZOS)
    img.save(path)
    print("wrote", path, size)


if __name__ == "__main__":
    import sys, os
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out, exist_ok=True)
    for s in (16, 32, 48, 128):
        make(s, os.path.join(out, f"icon{s}.png"))
