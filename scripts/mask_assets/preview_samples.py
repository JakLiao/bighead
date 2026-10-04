"""把样例蒙版叠到"假照片"上,生成对照图,便于人眼确认洞位与边框。"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "frontend" / "public" / "masks"
OUT = ROOT / "scripts" / "mask_assets" / "preview.png"

files = sorted(p for p in SRC.glob("*.png"))
cols, cw, ch = 4, 300, 225
rows = (len(files) + cols - 1) // cols
sheet = Image.new("RGB", (cols * cw, rows * ch), (34, 34, 40))
d = ImageDraw.Draw(sheet)

for i, f in enumerate(files):
    x, y = (i % cols) * cw, (i // cols) * ch
    # 假照片:对角渐变,洞里透出它就能看清窗口位置
    photo = Image.new("RGB", (cw - 8, ch - 26))
    pd = ImageDraw.Draw(photo)
    for yy in range(photo.height):
        t = yy / max(1, photo.height - 1)
        pd.line(
            [(0, yy), (photo.width, yy)],
            fill=(round(90 + 70 * t), round(110 - 30 * t), round(150 - 40 * t)),
        )
    mask = Image.open(f).convert("RGBA").resize((cw - 8, ch - 26), Image.LANCZOS)
    photo.paste(mask, (0, 0), mask)
    sheet.paste(photo, (x + 4, y + 4))
    d.text((x + 8, y + ch - 18), f.stem, fill=(240, 240, 240))

sheet.save(OUT)
print(f"对照图 → {OUT}  ({sheet.width}x{sheet.height})")
