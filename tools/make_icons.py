# Draws the toolbar icon: a struck-through "S" on paper, red pencil line.
# uv run -q --with pillow python tools/make_icons.py
from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.join(os.path.dirname(__file__), '..', 'icons')
os.makedirs(OUT, exist_ok=True)
PAPER, INK, RED = (244, 241, 234), (27, 26, 23), (214, 48, 32)

def font(px):
    for name in ('georgiab.ttf', 'georgia.ttf', 'timesbd.ttf', 'DejaVuSerif-Bold.ttf'):
        try:
            return ImageFont.truetype(name, px)
        except OSError:
            pass
    return ImageFont.load_default()

for size in (16, 32, 48, 128):
    S = 512
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, S - 1, S - 1], fill=PAPER, outline=INK, width=36)
    f = font(400)
    box = d.textbbox((0, 0), 'S', font=f)
    w, h = box[2] - box[0], box[3] - box[1]
    d.text(((S - w) / 2 - box[0], (S - h) / 2 - box[1] - 6), 'S', font=f, fill=INK)
    d.line([(70, 300), (442, 212)], fill=RED, width=56)
    im.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, f'icon{size}.png'))
print('icons written')
