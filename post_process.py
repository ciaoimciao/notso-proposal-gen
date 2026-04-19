"""
Post-processing pipeline for Notso AI mascot image generation.

Every image that comes back from Gemini / nano-banana / Replicate passes
through this module before being used in the proposal generator. The goal
is to guarantee three things:

  1. Background is cleanly transparent (true alpha, no fringe, no haloing).
  2. Output is normalized to a known canvas so the downstream PPTX / HTML
     renderers can drop it into any container without stretching.
  3. Garbage outputs (empty frames, single-pixel artefacts, model hallucinations
     where nothing was actually drawn) are rejected early with a clear error.

This module intentionally has a tiny surface area so callers can't accidentally
skip the alpha-cleaning step. Use process_mascot_bytes() for the normal path.

Dependencies:
  pip install --break-system-packages rembg pillow onnxruntime numpy

Locked: 2026-04-12  (v1.0)
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from typing import Literal

from PIL import Image, ImageFilter

try:
    from rembg import remove as rembg_remove
    _REMBG_AVAILABLE = True
except ImportError:
    _REMBG_AVAILABLE = False


# -----------------------------------------------------------------------------
# Target canvas sizes. These are the only two sizes the system produces.
# -----------------------------------------------------------------------------
CANVAS_SQUARE = (1024, 1024)      # character card, avatar, grid tile
CANVAS_PORTRAIT = (1024, 1536)    # hero shot, slide cover, full-body feature
CANVAS_LANDSCAPE = (1536, 1024)   # landscape hero, banner, feature strip


# -----------------------------------------------------------------------------
# Rejection thresholds.
# -----------------------------------------------------------------------------
# Fraction of canvas that must be opaque (alpha > 0) for the image to pass.
# Anything below this is treated as "model didn't actually draw the character".
MIN_OPAQUE_FRACTION = 0.03
# Maximum fraction — anything above this means the background removal failed
# and we still have a baked backdrop. Reject and re-process.
MAX_OPAQUE_FRACTION = 0.95


class MascotPostProcessError(RuntimeError):
    """Raised when an image fails post-processing validation."""


@dataclass
class ProcessedMascot:
    image: Image.Image
    canvas: tuple[int, int]
    opaque_fraction: float
    alpha_feather_px: int
    rembg_used: bool

    def to_png_bytes(self) -> bytes:
        buf = io.BytesIO()
        self.image.save(buf, format="PNG", optimize=True)
        return buf.getvalue()


# -----------------------------------------------------------------------------
# Step 1 — alpha cleaning via rembg
# -----------------------------------------------------------------------------
def clean_transparent_bg(img: Image.Image) -> Image.Image:
    """
    Remove the background and return an RGBA image with a clean alpha channel.

    If rembg is unavailable (e.g. in a lightweight dev environment), falls
    back to a simple white-threshold heuristic. The heuristic is not good
    enough for production — CI should refuse to deploy without rembg.
    """
    if _REMBG_AVAILABLE:
        # rembg.remove() accepts PIL.Image and returns PIL.Image in RGBA
        out = rembg_remove(img)
        if out.mode != "RGBA":
            out = out.convert("RGBA")
        return out

    # Fallback: naive threshold on near-white pixels
    img = img.convert("RGBA")
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if r > 240 and g > 240 and b > 240:
                px[x, y] = (r, g, b, 0)
    return img


# -----------------------------------------------------------------------------
# Step 2 — feather alpha edges
# -----------------------------------------------------------------------------
def feather_alpha(img: Image.Image, radius_px: int = 1) -> Image.Image:
    """
    Soften the alpha channel by a small gaussian blur so the edges don't
    alias when the downstream renderer scales the image up or down.
    """
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    r, g, b, a = img.split()
    a = a.filter(ImageFilter.GaussianBlur(radius=radius_px))
    return Image.merge("RGBA", (r, g, b, a))


# -----------------------------------------------------------------------------
# Step 3 — normalize to a fixed canvas
# -----------------------------------------------------------------------------
def normalize_to_canvas(
    img: Image.Image,
    canvas: tuple[int, int],
    padding_pct: float = 0.04,
) -> Image.Image:
    """
    Fit the character into a canvas of fixed size, preserving aspect ratio
    and centering it. Padding is a percentage of the smaller canvas dimension.
    """
    if img.mode != "RGBA":
        img = img.convert("RGBA")

    # Trim to the actual bounding box of the opaque content
    bbox = img.getbbox()
    if bbox is None:
        raise MascotPostProcessError(
            "Image is fully transparent after background removal."
        )
    img = img.crop(bbox)

    cw, ch = canvas
    pad = int(min(cw, ch) * padding_pct)
    target_w = cw - 2 * pad
    target_h = ch - 2 * pad

    # Scale to fit (preserve aspect)
    iw, ih = img.size
    scale = min(target_w / iw, target_h / ih)
    new_size = (max(1, int(iw * scale)), max(1, int(ih * scale)))
    img = img.resize(new_size, Image.LANCZOS)

    # Paste onto transparent canvas, centered
    out = Image.new("RGBA", canvas, (0, 0, 0, 0))
    x = (cw - new_size[0]) // 2
    y = (ch - new_size[1]) // 2
    out.paste(img, (x, y), img)
    return out


# -----------------------------------------------------------------------------
# Step 4 — validate
# -----------------------------------------------------------------------------
def validate_opaque_fraction(img: Image.Image) -> float:
    """
    Return the fraction of the canvas that has alpha > 0, and raise if it's
    outside the acceptable range.
    """
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    alpha = img.split()[3]
    total = alpha.size[0] * alpha.size[1]
    # bbox of non-zero alpha is a cheap proxy; for strict accounting,
    # use alpha.getextrema() + histogram
    hist = alpha.histogram()
    opaque_pixels = sum(hist[1:])  # bins 1..255
    frac = opaque_pixels / total

    if frac < MIN_OPAQUE_FRACTION:
        raise MascotPostProcessError(
            f"Rejected: only {frac:.1%} of canvas is opaque "
            f"(min {MIN_OPAQUE_FRACTION:.0%}). "
            "Model likely returned an empty or near-empty frame."
        )
    if frac > MAX_OPAQUE_FRACTION:
        raise MascotPostProcessError(
            f"Rejected: {frac:.1%} of canvas is opaque "
            f"(max {MAX_OPAQUE_FRACTION:.0%}). "
            "Background removal failed — a baked backdrop remains."
        )
    return frac


# -----------------------------------------------------------------------------
# End-to-end pipeline
# -----------------------------------------------------------------------------
def process_mascot_bytes(
    raw_bytes: bytes,
    canvas: Literal["square", "portrait", "landscape"] = "square",
    feather_radius: int = 1,
) -> ProcessedMascot:
    """
    Full pipeline: bytes → cleaned, feathered, normalized RGBA image.

    Raises MascotPostProcessError if the image fails validation.
    """
    canvas_size = {
        "square": CANVAS_SQUARE,
        "portrait": CANVAS_PORTRAIT,
        "landscape": CANVAS_LANDSCAPE,
    }[canvas]

    src = Image.open(io.BytesIO(raw_bytes))
    cleaned = clean_transparent_bg(src)
    feathered = feather_alpha(cleaned, radius_px=feather_radius)
    normalized = normalize_to_canvas(feathered, canvas_size)
    frac = validate_opaque_fraction(normalized)

    return ProcessedMascot(
        image=normalized,
        canvas=canvas_size,
        opaque_fraction=frac,
        alpha_feather_px=feather_radius,
        rembg_used=_REMBG_AVAILABLE,
    )


# -----------------------------------------------------------------------------
# CLI for quick iteration
# -----------------------------------------------------------------------------
if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("Usage: python3 post_process.py <input.png|.jpg> [--output <path>] [canvas]")
        print("  canvas = square | portrait | landscape   (default: square)")
        print("  --output <path>  write result to this path instead of *.clean.png")
        sys.exit(1)

    args = sys.argv[1:]
    src_path = args[0]
    out_path = None
    canvas_arg = "square"

    i = 1
    while i < len(args):
        if args[i] == "--output" and i + 1 < len(args):
            out_path = args[i + 1]
            i += 2
        elif args[i] in ("square", "portrait", "landscape"):
            canvas_arg = args[i]
            i += 1
        else:
            i += 1

    if out_path is None:
        out_path = src_path.rsplit(".", 1)[0] + ".clean.png"

    with open(src_path, "rb") as f:
        raw = f.read()

    result = process_mascot_bytes(raw, canvas=canvas_arg)
    with open(out_path, "wb") as f:
        f.write(result.to_png_bytes())

    print(f"✓ Wrote {out_path}")
    print(f"  canvas           = {result.canvas}")
    print(f"  opaque_fraction  = {result.opaque_fraction:.1%}")
    print(f"  alpha_feather_px = {result.alpha_feather_px}")
    print(f"  rembg_used       = {result.rembg_used}")
