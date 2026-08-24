#!/usr/bin/env python3
"""Prepare a handwritten order ticket for transcription in ONE pass.

Usage:
    python3 scripts/ticket_prep.py INPUT OUTDIR [--bands N]

INPUT may be an image, a PDF, or a base64 text file (what the Drive
connector's download returns). Everything is auto-detected.

Writes OUTDIR/full.jpg plus OUTDIR/band1.jpg .. bandN.jpg, and prints a JSON
manifest listing every file to read.

The point is that the caller runs this once and then reads all the output
images in a single batch, instead of cropping, looking, and cropping again.
"""

import base64
import json
import os
import shutil
import subprocess
import sys

MAX_FULL_WIDTH = 1600     # overview: enough to see layout, not to read pencil
BAND_TARGET_WIDTH = 2000  # bands: upscaled so faint handwriting survives
OVERLAP = 0.10            # bands overlap so no line is split across a seam


def ensure_pillow():
    """Import Pillow, installing it if the sandbox came up without it."""
    try:
        from PIL import Image, ImageOps  # noqa: F401
        return
    except ImportError:
        pass
    # Try each install strategy in turn. Sandboxes differ: some are plain,
    # some are PEP 668 "externally managed" and reject a bare install. Falling
    # through here costs one silent retry; guessing wrong costs a failed run.
    attempts = [
        [sys.executable, "-m", "pip", "install", "--quiet", "pillow"],
        [sys.executable, "-m", "pip", "install", "--quiet", "--user", "pillow"],
        [sys.executable, "-m", "pip", "install", "--quiet",
         "--break-system-packages", "pillow"],
    ]
    for cmd in attempts:
        if subprocess.run(cmd, capture_output=True).returncode == 0:
            try:
                from PIL import Image, ImageOps  # noqa: F401
                return
            except ImportError:
                continue
    sys.exit("could not import or install Pillow")


def looks_like_base64(path):
    with open(path, "rb") as fh:
        head = fh.read(64)
    if head[:3] == b"\xff\xd8\xff" or head[:8] == b"\x89PNG\r\n\x1a\n":
        return False
    if head[:4] == b"%PDF":
        return False
    stripped = bytes(c for c in head if c not in b"\r\n")
    allowed = set(
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="
    )
    return bool(stripped) and set(stripped) <= allowed


def materialize(src, workdir):
    """Return a real image path, decoding base64 and rasterizing PDF as needed."""
    path = src
    if looks_like_base64(path):
        with open(path, "r") as fh:
            data = base64.b64decode(fh.read(), validate=False)
        path = os.path.join(workdir, "decoded.bin")
        with open(path, "wb") as fh:
            fh.write(data)

    with open(path, "rb") as fh:
        magic = fh.read(4)
    if magic == b"%PDF":
        if not shutil.which("pdftoppm"):
            sys.exit("PDF input needs pdftoppm (poppler-utils), which is not installed")
        out = os.path.join(workdir, "page")
        subprocess.run(
            ["pdftoppm", "-jpeg", "-r", "200", "-f", "1", "-l", "1", path, out],
            check=True,
        )
        pages = sorted(
            os.path.join(workdir, f)
            for f in os.listdir(workdir)
            if f.startswith("page") and f.endswith(".jpg")
        )
        if not pages:
            sys.exit("pdftoppm produced no pages")
        return pages[0]
    return path


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    bands = 4
    for a in sys.argv[1:]:
        if a.startswith("--bands="):
            bands = int(a.split("=", 1)[1])
    if "--bands" in sys.argv:
        bands = int(sys.argv[sys.argv.index("--bands") + 1])
    if len(args) < 2:
        sys.exit(__doc__)
    src, outdir = args[0], args[1]

    ensure_pillow()
    from PIL import Image, ImageOps

    os.makedirs(outdir, exist_ok=True)
    path = materialize(src, outdir)

    img = Image.open(path)
    # Phone photos carry rotation in EXIF; without this the ticket lands sideways
    # and every downstream crop is wrong.
    img = ImageOps.exif_transpose(img).convert("RGB")
    w, h = img.size

    manifest = {"source": src, "original_size": [w, h], "images": []}

    full = img.copy()
    if w > MAX_FULL_WIDTH:
        full = full.resize((MAX_FULL_WIDTH, int(h * MAX_FULL_WIDTH / w)), Image.LANCZOS)
    full_path = os.path.join(outdir, "full.jpg")
    full.save(full_path, quality=88)
    manifest["images"].append({"file": full_path, "role": "whole ticket, layout only"})

    step = h / bands
    pad = step * OVERLAP
    for i in range(bands):
        top = max(0, int(i * step - pad))
        bottom = min(h, int((i + 1) * step + pad))
        band = img.crop((0, top, w, bottom))
        bw, bh = band.size
        if bw < BAND_TARGET_WIDTH:
            scale = BAND_TARGET_WIDTH / bw
            band = band.resize((BAND_TARGET_WIDTH, int(bh * scale)), Image.LANCZOS)
        band_path = os.path.join(outdir, f"band{i + 1}.jpg")
        band.save(band_path, quality=92)
        manifest["images"].append({
            "file": band_path,
            "role": f"rows {top}-{bottom} of {h}, magnified for reading",
        })

    # Leave only readable images behind, so nothing in OUTDIR invites a
    # pointless Read of a decode/rasterize intermediate.
    for junk in os.listdir(outdir):
        jp = os.path.join(outdir, junk)
        if jp != full_path and not junk.startswith("band"):
            os.remove(jp)

    manifest["read_all_of_these_in_one_batch"] = [
        i["file"] for i in manifest["images"]
    ]
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
