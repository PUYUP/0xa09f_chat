#!/usr/bin/env python3
"""Visual checks: render the real UI (desktop/ui) in headless Chrome with a
stubbed Tauri API, set up a state with a demo script, and save a screenshot.
No server, no app build needed — for looking at layouts and themes.

    python3 tests/visual/run.py              # all demos -> tests/visual/out/*.png
    python3 tests/visual/run.py themes dark  # some of them

A demo is demos/<name>.js; its first line may say `// size: 1000x520`. A demo
may render several variants: `// variants: night beach rain` runs it once per
variant with `location.hash` set to it. JavaScript errors fail the demo.

Chrome won't make a window narrower than MIN_W, so a phone-sized demo is
rendered in an iframe of exactly that size and the screenshot is cropped.

Needs Google Chrome (or set CHROME=/path/to/chrome).
"""

import os
import re
import shutil
import subprocess
import sys
import struct
import tempfile
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
UI = os.path.join(os.path.dirname(os.path.dirname(HERE)), "desktop", "ui")
OUT = os.path.join(HERE, "out")
CHROME = os.environ.get("CHROME") or next(
    (p for p in ("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                 shutil.which("google-chrome") or "", shutil.which("chromium") or "") if p and os.path.exists(p)), None)

STUB = """<script>
window.onerror = (m, s, l) => document.documentElement.setAttribute("data-err", m + " @" + l);
window.__TAURI__ = {
  core: { invoke: async () => null },
  event: { listen: async () => () => {} },
  window: { getCurrentWindow: () => ({ setTitle: async () => {}, outerPosition: async () => ({ x: 0, y: 0 }),
    setPosition: async () => {}, setFocus: async () => {}, unminimize: async () => {}, requestUserAttention: async () => {} }) },
  dpi: { PhysicalPosition: function () {} },
};
</script>"""


MIN_W = 500   # headless Chrome clamps narrower windows to this


def crop_png(path, w, h):
    """Crop an 8-bit, non-interlaced RGB/RGBA PNG (what Chrome writes) to w x h, stdlib only."""
    with open(path, "rb") as f:
        data = f.read()
    pos, idat, ihdr = 8, b"", None
    while pos < len(data):
        n, kind = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + n]
        if kind == b"IHDR":
            ihdr = body
        elif kind == b"IDAT":
            idat += body
        pos += 12 + n
    W, H, depth, ctype = struct.unpack(">IIBB", ihdr[:10])
    if depth != 8 or ctype not in (2, 6) or ihdr[12]:
        return
    bpp = 4 if ctype == 6 else 3
    stride, raw = W * bpp, zlib.decompress(idat)
    prev, rows = bytearray(stride), []
    for y in range(min(H, h)):
        ft, line = raw[y * (stride + 1)], bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0
            b, c = prev[i], (prev[i - bpp] if i >= bpp else 0)
            if ft == 1: line[i] = (line[i] + a) & 255
            elif ft == 2: line[i] = (line[i] + b) & 255
            elif ft == 3: line[i] = (line[i] + (a + b) // 2) & 255
            elif ft == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append(b"\0" + bytes(line[:w * bpp]))
        prev = line

    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">II", w, len(rows)) + ihdr[8:])
                + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b""))


def chrome(args):
    return subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", *args],
                          capture_output=True, text=True, timeout=60)


def run(name, work):
    with open(os.path.join(HERE, "demos", f"{name}.js")) as f:
        demo = f.read()
    size = re.search(r"//\s*size:\s*(\d+)x(\d+)", demo)
    w, h = (size.group(1), size.group(2)) if size else ("1000", "600")
    variants = (re.search(r"//\s*variants:\s*(.+)", demo) or [None, ""])[1].split() or [""]
    shutil.copy(os.path.join(HERE, "demos", f"{name}.js"), os.path.join(work, "demo.js"))
    ok = True
    for v in variants:
        url = f"file://{work}/index.html" + (f"#{v}" if v else "")
        err = re.search(r'data-err="([^"]*)"', chrome(["--dump-dom", url]).stdout)
        png = os.path.join(OUT, f"{name}{'-' + v if v else ''}.png")
        if int(w) < MIN_W:
            frame = os.path.join(work, "frame.html")
            with open(frame, "w") as f:
                f.write(f'<body style="margin:0"><iframe src="index.html{"#" + v if v else ""}" '
                        f'style="width:{w}px;height:{h}px;border:0;display:block"></iframe>')
            chrome([f"--window-size={MIN_W},{h}", f"--screenshot={png}", f"file://{frame}"])
            crop_png(png, int(w), int(h))
        else:
            chrome([f"--window-size={w},{h}", f"--screenshot={png}", url])
        if err:
            ok = False
            print(f"  [FAIL] {name}{' ' + v if v else ''}: {err.group(1)}")
        else:
            print(f"  [ OK ] {os.path.relpath(png)}")
    return ok


def main():
    if not CHROME:
        sys.exit("Google Chrome not found (set CHROME=...)")
    os.makedirs(OUT, exist_ok=True)
    work = tempfile.mkdtemp(prefix="snailog-visual-")
    for f in os.listdir(UI):
        if os.path.isfile(os.path.join(UI, f)):
            shutil.copy(os.path.join(UI, f), work)
    with open(os.path.join(work, "index.html")) as f:
        html = f.read()
    with open(os.path.join(work, "index.html"), "w") as f:
        f.write(html.replace('<script src="app.js"></script>',
                             STUB + '<script src="app.js"></script><script src="demo.js"></script>'))
    names = sys.argv[1:] or sorted(f[:-3] for f in os.listdir(os.path.join(HERE, "demos")) if f.endswith(".js"))
    results = [run(n, work) for n in names]
    shutil.rmtree(work, ignore_errors=True)
    print(f"\n{sum(results)}/{len(results)} demos rendered without errors; screenshots in {os.path.relpath(OUT)}/")
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
