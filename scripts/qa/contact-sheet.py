#!/usr/bin/env python3
"""Contact sheet of out/themes/<scheme>-gd.png and -java.png side by side, one row per scheme, with the theme name."""
import json, os, re, sys
from PIL import Image, ImageDraw, ImageFont

here = os.path.dirname(os.path.abspath(__file__))
out = os.path.join(here, "out/themes")
src = open(os.path.join(here, "../../src/theme/schemes.ts")).read()
names = dict(re.findall(r'id: "([a-z0-9-]+)", name: "([^"]+)"', src))
order = re.findall(r'id: "([a-z0-9-]+)", name:', src)
W = 1000  # width of one screenshot in the sheet
rows = []
for sid in order:
    imgs = []
    for k in ("gd", "java"):
        p = os.path.join(out, f"{sid}-{k}.png")
        if os.path.exists(p):
            im = Image.open(p).convert("RGB")
            imgs.append(im.resize((W, int(im.height * W / im.width)), Image.LANCZOS))
    if imgs:
        rows.append((names.get(sid, sid), imgs))
if not rows:
    sys.exit("no screenshots in " + out)
H = max(i.height for _, ims in rows for i in ims)
pad, head = 16, 44
sheet = Image.new("RGB", (pad + (W + pad) * 2, pad + (H + head + pad) * len(rows)), (24, 24, 28))
d = ImageDraw.Draw(sheet)
try:
    font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 28)
except Exception:
    font = ImageFont.load_default()
for r, (name, ims) in enumerate(rows):
    y = pad + r * (H + head + pad)
    d.text((pad, y + 4), f"{r + 1}. {name}", fill=(235, 235, 240), font=font)
    for c, im in enumerate(ims):
        sheet.paste(im, (pad + c * (W + pad), y + head))
dest = os.path.join(out, "contact-sheet.png")
sheet.save(dest)
print(dest, sheet.size)
