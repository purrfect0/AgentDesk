"""Draws the Agent Desk icon (Win98-style monitor with a to-do list) and writes:
desktop/icon.ico, desktop/icon.png (window, tray, installer) and mobile/assets/* (Android).
Own pixel art, so the app icon does not depend on downloaded files. Needs Pillow."""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
K, W, S, D, N = (0, 0, 0, 255), (255, 255, 255, 255), (192, 192, 192, 255), (128, 128, 128, 255), (0, 0, 128, 255)
GREEN, YELLOW, RED, TEAL = (0, 255, 0, 255), (255, 255, 0, 255), (255, 0, 0, 255), (0, 128, 128, 255)


def rect(px, x0, y0, x1, y1, c):
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            px[x, y] = c


def bevel(px, x0, y0, x1, y1, fill, light=W, dark=D):
    rect(px, x0, y0, x1, y1, K)
    rect(px, x0 + 1, y0 + 1, x1 - 1, y1 - 1, fill)
    rect(px, x0 + 1, y0 + 1, x1 - 1, y0 + 1, light)
    rect(px, x0 + 1, y0 + 1, x0 + 1, y1 - 1, light)
    rect(px, x0 + 1, y1 - 1, x1 - 1, y1 - 1, dark)
    rect(px, x1 - 1, y0 + 1, x1 - 1, y1 - 1, dark)


def draw32():
    im = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    px = im.load()
    bevel(px, 2, 2, 29, 23, S)            # monitor case
    rect(px, 5, 5, 26, 19, D)             # sunken screen frame
    rect(px, 6, 6, 26, 19, W)
    rect(px, 6, 6, 25, 18, K)
    rect(px, 7, 7, 25, 18, N)             # blue screen
    for y, mark, length in ((9, GREEN, 21), (12, YELLOW, 19), (15, RED, 22)):
        rect(px, 9, y, 10, y + 1, mark)  # status box
        rect(px, 13, y, length, y, W)     # task line
        rect(px, 13, y + 1, length - 3, y + 1, (160, 160, 255, 255))
    rect(px, 25, 21, 26, 21, GREEN)       # power led
    rect(px, 12, 24, 19, 25, K)           # neck
    rect(px, 13, 24, 18, 24, S)
    bevel(px, 6, 25, 25, 29, S)           # base
    return im


def classic():
    """The original Agent Board icon: Windows 98 "two networked PCs" (web/icons, from fetch-assets.js).
    Falls back to the drawn monitor if the icons were not downloaded."""
    icons = ROOT / "web" / "icons"
    try:
        return (Image.open(icons / "network_normal_two_pcs-0.png").convert("RGBA"),
                Image.open(icons / "network_normal_two_pcs-1.png").convert("RGBA"))
    except OSError:
        icon = draw32()
        return icon, icon.resize((16, 16), Image.BOX)


def main():
    icon, small = classic()
    big = {n: icon.resize((n, n), Image.NEAREST) for n in (16, 32, 48, 64, 128, 256)}
    big[16] = small.resize((16, 16), Image.NEAREST)
    (ROOT / "desktop").mkdir(exist_ok=True)
    big[256].save(ROOT / "desktop" / "icon.png")
    big[256].save(ROOT / "desktop" / "icon.ico", sizes=[(n, n) for n in (16, 32, 48, 64, 128, 256)],
                  append_images=[big[n] for n in (16, 32, 48, 64, 128)])

    assets = ROOT / "mobile" / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    full = Image.new("RGBA", (1024, 1024), TEAL)
    full.alpha_composite(icon.resize((768, 768), Image.NEAREST), (128, 128))
    full.convert("RGB").save(assets / "icon-only.png")
    fg = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    fg.alpha_composite(icon.resize((576, 576), Image.NEAREST), (224, 224))  # inside the adaptive-icon safe zone
    fg.save(assets / "icon-foreground.png")
    Image.new("RGB", (1024, 1024), TEAL[:3]).save(assets / "icon-background.png")
    splash = Image.new("RGB", (2732, 2732), TEAL[:3])
    splash.paste(icon.resize((512, 512), Image.NEAREST), (1110, 1110), icon.resize((512, 512), Image.NEAREST))
    splash.save(assets / "splash.png")
    splash.save(assets / "splash-dark.png")
    print("icons ok")


if __name__ == "__main__":
    main()
