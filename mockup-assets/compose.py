#!/usr/bin/env python3
"""
Mockup compositor — phone + laptop, parameterized by mascot name + brand color.

Produces:
  - Phone: screen content with rounded corners matching the bezel, no white spill
  - Laptop: website + phone-in-bottom-right, phone is fully opaque over website

Usage (as script):
  python3 compose.py                               # default: Notso + red
  python3 compose.py --name Yazi --color '#88ADA6' # Yazi + lake green
  python3 compose.py --all                         # generate both samples

Usage (as module):
  from compose import build_phone, build_laptop
  build_phone(mascot_img, name='Yazi', color='#88ADA6', out='phone.png')
  build_laptop(mascot_img, website_img, name='Yazi', color='#88ADA6', out='laptop.png')
"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from scipy.ndimage import binary_fill_holes, binary_closing, binary_opening, label
import numpy as np
import os
import argparse

HERE = os.path.dirname(os.path.abspath(__file__))
OUT  = os.path.join(HERE, 'samples')
os.makedirs(OUT, exist_ok=True)

FONT      = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'

# ── Detected screen rectangles (from bezel analysis) ─────────────────
PHONE_SCREEN  = (1615, 601, 3391, 4398)   # (x1, y1, x2, y2) — interior of bezel
LAPTOP_SCREEN = (768, 1211, 3396, 2858)

# Corner radii for screen content (match rounded bezels inside)
PHONE_SCREEN_RADIUS  = 220   # iPhone-style rounded corners
LAPTOP_SCREEN_RADIUS = 20    # laptops are near-square with tiny rounding


# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────

def hex_to_rgb(h):
    h = h.lstrip('#')
    if len(h) == 3:
        h = ''.join(c*2 for c in h)
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))


def silhouette_mask(rgb_image, tolerance=18):
    """
    Build a solid alpha mask of the device silhouette from a JPEG mockup
    whose background is a (possibly gradient) light color.

    Estimates a per-pixel "expected background color" by bilinearly
    interpolating the four corner colors of the image. A pixel is
    considered background when its distance to the expected bg is below
    `tolerance`. That handles both uniform white frames and grey-gradient
    frames where corner-to-corner brightness differs by 20+ levels.

    Returns: numpy array of uint8, same HxW as input, 0=outside, 255=inside.
    """
    arr = np.array(rgb_image.convert('RGB')).astype(np.float32)
    h, w, _ = arr.shape

    # Four corner colors (patch-averaged for noise robustness)
    patch = 12
    tl = arr[:patch, :patch].mean(axis=(0, 1))
    tr = arr[:patch, -patch:].mean(axis=(0, 1))
    bl = arr[-patch:, :patch].mean(axis=(0, 1))
    br = arr[-patch:, -patch:].mean(axis=(0, 1))

    # Bilinear field of expected bg color at each pixel
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    u = xx / max(w - 1, 1)
    v = yy / max(h - 1, 1)
    u3 = u[..., None]; v3 = v[..., None]
    expected = (
        (1 - u3) * (1 - v3) * tl +
        u3       * (1 - v3) * tr +
        (1 - u3) * v3       * bl +
        u3       * v3       * br
    )

    diff = arr - expected
    dist = np.sqrt((diff * diff).sum(axis=2))
    non_bg = dist >= tolerance

    # Close small gaps at bezel edge, then fill interior holes (screen area)
    non_bg = binary_closing(non_bg, iterations=3)
    filled = binary_fill_holes(non_bg)
    # Remove tiny speckles outside the device
    filled = binary_opening(filled, iterations=2)
    filled = binary_fill_holes(filled)

    # Keep only the LARGEST connected component — drops any stray shadows,
    # desk surfaces, or reflections that came with the frame JPG.
    labeled, num = label(filled)
    if num > 1:
        sizes = np.bincount(labeled.ravel())
        sizes[0] = 0  # background label
        largest = sizes.argmax()
        filled = (labeled == largest)

    return (filled * 255).astype(np.uint8)


def rounded_corner_mask(size, radius):
    """Return an L-mode PIL Image with a rounded rectangle mask (255 inside)."""
    w, h = size
    mask = Image.new('L', (w, h), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, w-1, h-1], radius=radius, fill=255)
    return mask


def apply_mask(im, mask):
    """Return a copy of im with its alpha replaced by `mask` (multiplied with existing alpha)."""
    im = im.convert('RGBA')
    existing = np.array(im.split()[-1], dtype=np.uint16)
    m = np.array(mask.resize(im.size) if mask.size != im.size else mask, dtype=np.uint16)
    new_alpha = ((existing * m) // 255).astype(np.uint8)
    out = im.copy()
    out.putalpha(Image.fromarray(new_alpha, 'L'))
    return out


def drop_shadow(im, offset=(0, 20), blur=30, opacity=80):
    """Soft drop shadow around an RGBA image. Returns a larger RGBA image."""
    w, h = im.size
    pad = blur * 2
    canvas = Image.new('RGBA', (w + pad*2, h + pad*2), (0, 0, 0, 0))
    alpha = im.split()[-1]
    shadow_alpha = alpha.point(lambda a: int(a * opacity / 255))
    shadow = Image.new('RGBA', (w, h), (0, 0, 0, 255))
    shadow.putalpha(shadow_alpha)
    canvas.alpha_composite(shadow, (pad + offset[0], pad + offset[1]))
    canvas = canvas.filter(ImageFilter.GaussianBlur(blur))
    canvas.alpha_composite(im, (pad, pad))
    return canvas


# ─────────────────────────────────────────────────────────────────────
# Phone screen content
# ─────────────────────────────────────────────────────────────────────

# ─── Industry-based dialogue templates ──────────────────────────────
# Keyed by industry/use-case keyword; picks (mascot_line, user_line).
# The mascot line uses {name} for the mascot name, {client} for client name.
DIALOGUES = {
    'nutrition': ("Hi! I'm {name}. What did you eat today?",
                  "A big salad and coffee"),
    'health':    ("Hi! I'm {name}. How can I support your health today?",
                  "What should I eat for dinner?"),
    'fitness':   ("Hi! I'm {name}. Ready for today's workout?",
                  "Give me a quick 20-min routine"),
    'finance':   ("Hi! I'm {name}. Let's talk about your finances.",
                  "How do I save more this month?"),
    'sport':     ("Hi! I'm {name}. Where's your club running into trouble?",
                  "Our finances need help"),
    'education': ("Hi! I'm {name}. Ready to learn something new?",
                  "Teach me about photosynthesis"),
    'retail':    ("Hi! I'm {name}. Looking for anything in particular?",
                  "A red shirt in size M"),
    'charity':   ("Hi! I'm {name}. Want to hear about our mission?",
                  "How can I help donate today?"),
    'default':   ("Hi! I'm {name}. What can I help you with?",
                  "Tell me more about what you do"),
}


def pick_dialogue(industry, mascot_name):
    """Match industry keyword against DIALOGUES; returns (mascot_line, user_line)."""
    key = (industry or 'default').lower()
    # Keyword match
    for k in DIALOGUES:
        if k in key:
            m, u = DIALOGUES[k]
            return m.format(name=mascot_name), u
    m, u = DIALOGUES['default']
    return m.format(name=mascot_name), u


def build_phone_screen_content(sw, sh, mascot, *, mascot_name, brand_rgb,
                               mascot_line=None, user_line=None, industry=None):
    """
    The content that goes INSIDE the phone screen (before masking).
    Light grey bg, top labels, mascot bubble (left) + user bubble (right),
    mascot image, bottom input bar.
    """
    # Pick dialogue
    if mascot_line is None or user_line is None:
        m_line, u_line = pick_dialogue(industry, mascot_name)
        mascot_line = mascot_line or m_line
        user_line   = user_line   or u_line

    BG = (242, 242, 242, 255)
    img = Image.new('RGBA', (sw, sh), BG)
    d = ImageDraw.Draw(img)

    # Fonts — body is ~+4-8px larger than before (sh // 60 vs sh // 75)
    f_small = ImageFont.truetype(FONT,      max(32, sh // 100))
    f_body  = ImageFont.truetype(FONT,      max(58, sh // 60))   # ← bumped up
    f_label = ImageFont.truetype(FONT,      max(38, sh // 90))
    f_input = ImageFont.truetype(FONT,      max(52, sh // 70))

    # Top-right "online"
    top_pad = int(sh * 0.055)
    txt = 'online'
    tw = d.textlength(txt, font=f_small)
    d.text((sw - tw - int(sw*0.08), top_pad), txt, fill=(60, 60, 60, 255), font=f_small)

    # Label "{name} // online"
    label_y = top_pad + int(sh * 0.04)
    d.text((int(sw*0.08), label_y), f'{mascot_name} // online',
           fill=(90, 90, 90, 255), font=f_label)

    # ── Chat bubbles helper ──
    def draw_bubble(text, align, top_y, max_width_ratio=0.78, is_user=False):
        """Draw a chat bubble. align='left' or 'right'. Returns bottom_y."""
        pad_x = int(sw * 0.055)
        pad_y = int(sh * 0.022)
        max_w = int(sw * max_width_ratio)
        # Wrap text
        words = text.split()
        lines, line = [], ''
        for w in words:
            test = (line + ' ' + w).strip()
            if d.textlength(test, font=f_body) < max_w - 2*pad_x:
                line = test
            else:
                lines.append(line); line = w
        if line: lines.append(line)
        # Compute bubble size
        line_h = f_body.size + 16
        # Find actual text width (bubble shrinks to fit content, up to max_w)
        text_w = max(d.textlength(ln, font=f_body) for ln in lines)
        bub_w = int(text_w + 2*pad_x)
        bub_h = int(len(lines) * line_h + 2*pad_y + 10)
        # Position
        margin = int(sw * 0.07)
        if align == 'left':
            x1 = margin
        else:
            x1 = sw - margin - bub_w
        x2 = x1 + bub_w
        y1 = top_y
        y2 = y1 + bub_h
        # Shadow
        shadow = Image.new('RGBA', (sw, sh), (0,0,0,0))
        sd = ImageDraw.Draw(shadow)
        sd.rounded_rectangle((x1+5, y1+10, x2+5, y2+10),
                             radius=int(sw*0.03), fill=(0,0,0,38))
        shadow = shadow.filter(ImageFilter.GaussianBlur(10))
        img.alpha_composite(shadow)
        # Bubble fill + text color
        if is_user:
            fill = (*brand_rgb, 255)
            text_c = (255, 255, 255, 255)
        else:
            fill = (255, 255, 255, 255)
            text_c = (30, 30, 30, 255)
        d.rounded_rectangle((x1, y1, x2, y2),
                            radius=int(sw*0.03), fill=fill)
        ty = y1 + pad_y
        for ln in lines:
            d.text((x1 + pad_x, ty), ln, fill=text_c, font=f_body)
            ty += line_h
        return y2

    # ── Mascot bubble (left) + User bubble (right) ──
    first_y  = label_y + int(sh * 0.05)
    bub1_end = draw_bubble(mascot_line, 'left',  first_y, is_user=False)
    bub2_end = draw_bubble(user_line,   'right', bub1_end + int(sh * 0.018),
                           is_user=True)

    # Mascot — fit between bubbles and bottom input
    bottom_bar_h = int(sh * 0.10)
    bottom_bar_pad = int(sh * 0.035)
    mascot_top    = bub2_end + int(sh * 0.015)
    mascot_bottom = sh - bottom_bar_h - bottom_bar_pad - int(sh * 0.01)
    mascot_area_h = mascot_bottom - mascot_top
    mascot_area_w = int(sw * 0.92)
    mw, mh = mascot.size
    scale = min(mascot_area_w / mw, mascot_area_h / mh)
    new_w, new_h = int(mw * scale), int(mh * scale)
    m_resized = mascot.resize((new_w, new_h), Image.LANCZOS)
    mx = (sw - new_w) // 2
    my = mascot_top + (mascot_area_h - new_h) // 2
    img.alpha_composite(m_resized, (mx, my))

    # Bottom input bar: white with brand-color outline + chevron
    input_margin = int(sw * 0.06)
    ix1 = input_margin
    ix2 = sw - input_margin
    iy1 = sh - bottom_bar_h - bottom_bar_pad
    iy2 = sh - bottom_bar_pad
    d.rounded_rectangle((ix1, iy1, ix2, iy2), radius=(iy2-iy1)//2,
                        fill=(255,255,255,255),
                        outline=(*brand_rgb, 255), width=4)
    d.text((ix1 + int(sw*0.05), iy1 + (iy2-iy1-f_input.size)//2 - 4),
           'Ask a question', fill=(120, 120, 120, 255), font=f_input)
    f_chev = ImageFont.truetype(FONT_BOLD, int((iy2-iy1)*0.55))
    cw = d.textlength('>', font=f_chev)
    d.text((ix2 - cw - int(sw*0.06), iy1 + (iy2-iy1-f_chev.size)//2 - 4),
           '>', fill=(*brand_rgb, 255), font=f_chev)

    return img


# ─────────────────────────────────────────────────────────────────────
# Phone mockup builder
# ─────────────────────────────────────────────────────────────────────

def build_phone(mascot, phone_frame, *, mascot_name='Notso',
                brand_color='#DC2626', industry=None,
                mascot_line=None, user_line=None, out=None):
    """
    Build the phone mockup. `phone_frame` must be a pre-processed RGBA PNG
    where outside the phone and the screen interior are both transparent,
    and only the bezel/body pixels are opaque (see preprocess_frames.py).

    Outputs an RGBA image: transparent outside, screen content visible
    through the bezel hole.
    """
    brand_rgb = hex_to_rgb(brand_color)
    x1, y1, x2, y2 = PHONE_SCREEN
    sw, sh = x2 - x1, y2 - y1

    # 1) Build screen content (chat UI)
    content = build_phone_screen_content(sw, sh, mascot,
                                          mascot_name=mascot_name,
                                          brand_rgb=brand_rgb,
                                          mascot_line=mascot_line,
                                          user_line=user_line,
                                          industry=industry)

    # 2) Mask screen content with rounded corners matching bezel interior
    rc_mask = rounded_corner_mask((sw, sh), PHONE_SCREEN_RADIUS)
    content = apply_mask(content, rc_mask)

    # 3) Build canvas, paste content at screen coords, then overlay transparent frame
    frame = phone_frame.convert('RGBA')
    canvas = Image.new('RGBA', frame.size, (0, 0, 0, 0))
    canvas.alpha_composite(content, (x1, y1))
    canvas.alpha_composite(frame)   # bezel on top, transparent screen lets content show

    if out:
        canvas.save(out, optimize=True)
    return canvas


# ─────────────────────────────────────────────────────────────────────
# Chat-window popup (for laptop overlay — website-style floating widget)
# ─────────────────────────────────────────────────────────────────────

def build_chat_window(mascot, *, width, height, mascot_name, brand_rgb,
                      mascot_line=None, user_line=None, industry=None,
                      corner_radius=32):
    """
    Website-style chat-popup widget (rounded rectangle, branded header,
    two chat bubbles, mascot image, input bar). No phone bezel.

    Returns RGBA image sized exactly (width, height), with transparent
    pixels outside the rounded rect so only the popup shape is visible.
    """
    # Resolve dialogue
    if mascot_line is None or user_line is None:
        m_line, u_line = pick_dialogue(industry, mascot_name)
        mascot_line = mascot_line or m_line
        user_line   = user_line   or u_line

    w, h = width, height
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Window background (white, rounded)
    d.rounded_rectangle((0, 0, w - 1, h - 1),
                        radius=corner_radius, fill=(255, 255, 255, 255))

    # ── Header: brand color with mascot name + "online" ──
    header_h = int(h * 0.11)
    # Top corners rounded, bottom straight — draw as rounded rect then cover the bottom half
    d.rounded_rectangle((0, 0, w - 1, header_h),
                        radius=corner_radius, fill=(*brand_rgb, 255))
    d.rectangle((0, corner_radius, w - 1, header_h),
                fill=(*brand_rgb, 255))

    f_header = ImageFont.truetype(FONT_BOLD, max(22, h // 30))
    f_small  = ImageFont.truetype(FONT,      max(16, h // 42))
    f_body   = ImageFont.truetype(FONT,      max(20, h // 34))
    f_input  = ImageFont.truetype(FONT,      max(18, h // 38))

    # Header text
    d.text((int(w * 0.05), (header_h - f_header.size) // 2 - 2),
           mascot_name, fill=(255, 255, 255, 255), font=f_header)
    # Online pill (right side) — small white dot + "online"
    dot_r = max(5, h // 140)
    dot_cx = int(w * 0.72)
    dot_cy = header_h // 2
    d.ellipse((dot_cx - dot_r, dot_cy - dot_r,
               dot_cx + dot_r, dot_cy + dot_r),
              fill=(180, 255, 180, 255))
    d.text((dot_cx + dot_r + 8, dot_cy - f_small.size // 2 - 2),
           'online', fill=(255, 255, 255, 230), font=f_small)

    # ── Chat bubbles ──
    body_x = int(w * 0.05)
    body_right = w - body_x
    bubble_top = header_h + int(h * 0.035)

    def draw_bubble(text, align, top_y, is_user=False):
        pad_x = int(w * 0.04)
        pad_y = int(h * 0.016)
        max_w = int((body_right - body_x) * 0.82)
        # Wrap
        words, lines, line = text.split(), [], ''
        for word in words:
            test = (line + ' ' + word).strip()
            if d.textlength(test, font=f_body) < max_w - 2 * pad_x:
                line = test
            else:
                lines.append(line); line = word
        if line: lines.append(line)
        line_h = f_body.size + 10
        text_w = max(d.textlength(ln, font=f_body) for ln in lines)
        bw = int(text_w + 2 * pad_x)
        bh = int(len(lines) * line_h + 2 * pad_y + 6)
        if align == 'left':
            x1 = body_x
        else:
            x1 = body_right - bw
        x2 = x1 + bw
        y1 = top_y
        y2 = y1 + bh
        # Shadow
        shadow = Image.new('RGBA', (w, h), (0, 0, 0, 0))
        sd = ImageDraw.Draw(shadow)
        sd.rounded_rectangle((x1 + 2, y1 + 4, x2 + 2, y2 + 4),
                             radius=int(h * 0.022), fill=(0, 0, 0, 30))
        shadow = shadow.filter(ImageFilter.GaussianBlur(4))
        img.alpha_composite(shadow)
        if is_user:
            fill_c = (*brand_rgb, 255)
            text_c = (255, 255, 255, 255)
        else:
            fill_c = (240, 240, 242, 255)
            text_c = (30, 30, 30, 255)
        d.rounded_rectangle((x1, y1, x2, y2),
                            radius=int(h * 0.022), fill=fill_c)
        ty = y1 + pad_y
        for ln in lines:
            d.text((x1 + pad_x, ty), ln, fill=text_c, font=f_body)
            ty += line_h
        return y2

    bub1_end = draw_bubble(mascot_line, 'left',  bubble_top, is_user=False)
    bub2_end = draw_bubble(user_line,   'right', bub1_end + int(h * 0.012),
                           is_user=True)

    # ── Mascot image ──
    bottom_bar_h = int(h * 0.10)
    bottom_pad   = int(h * 0.028)
    mascot_top    = bub2_end + int(h * 0.01)
    mascot_bottom = h - bottom_bar_h - bottom_pad - int(h * 0.012)
    mascot_area_h = max(0, mascot_bottom - mascot_top)
    mascot_area_w = int(w * 0.80)
    if mascot_area_h > 20 and mascot is not None:
        mw, mh = mascot.size
        scale = min(mascot_area_w / mw, mascot_area_h / mh)
        nw, nh = int(mw * scale), int(mh * scale)
        m_resized = mascot.resize((nw, nh), Image.LANCZOS)
        mx = (w - nw) // 2
        my = mascot_top + (mascot_area_h - nh) // 2
        img.alpha_composite(m_resized, (mx, my))

    # ── Bottom input bar ──
    ix1 = int(w * 0.05)
    ix2 = w - ix1
    iy1 = h - bottom_bar_h - bottom_pad
    iy2 = h - bottom_pad
    d.rounded_rectangle((ix1, iy1, ix2, iy2),
                        radius=(iy2 - iy1) // 2,
                        fill=(255, 255, 255, 255),
                        outline=(*brand_rgb, 255), width=3)
    d.text((ix1 + int(w * 0.04),
            iy1 + (iy2 - iy1 - f_input.size) // 2 - 3),
           'Ask a question', fill=(140, 140, 140, 255), font=f_input)
    f_chev = ImageFont.truetype(FONT_BOLD, int((iy2 - iy1) * 0.55))
    cw = d.textlength('>', font=f_chev)
    d.text((ix2 - cw - int(w * 0.05),
            iy1 + (iy2 - iy1 - f_chev.size) // 2 - 4),
           '>', fill=(*brand_rgb, 255), font=f_chev)

    # ── Clip to rounded rectangle so corners are clean ──
    mask = rounded_corner_mask((w, h), corner_radius)
    img = apply_mask(img, mask)
    return img


# ─────────────────────────────────────────────────────────────────────
# Laptop mockup builder
# ─────────────────────────────────────────────────────────────────────

def build_laptop(mascot, laptop_frame, website, *,
                 mascot_name='Notso', brand_color='#DC2626',
                 industry=None, mascot_line=None, user_line=None,
                 window_scale=0.72, out=None):
    """
    Put website inside laptop screen and overlay a rounded-corner chat
    popup (website-style widget, NOT a phone) at the bottom-right with
    a soft drop shadow — like a live chat dialog floating over the site.

    `window_scale` = chat popup height as fraction of screen height.
    """
    brand_rgb = hex_to_rgb(brand_color)
    x1, y1, x2, y2 = LAPTOP_SCREEN
    sw, sh = x2 - x1, y2 - y1

    # Website cover-fit into screen area
    ww, wh = website.size
    scale = max(sw / ww, sh / wh)
    nw, nh = int(ww * scale), int(wh * scale)
    web = website.resize((nw, nh), Image.LANCZOS).convert('RGBA')
    cx, cy = (nw - sw) // 2, (nh - sh) // 2
    web = web.crop((cx, cy, cx + sw, cy + sh))

    # Apply rounded-corner mask matching laptop screen bezel
    rc_mask = rounded_corner_mask((sw, sh), LAPTOP_SCREEN_RADIUS)
    web = apply_mask(web, rc_mask)

    # Build chat window — taller than wide, like a chat dock
    win_h = int(sh * window_scale)
    win_w = int(win_h * 0.56)   # ~9:16-ish, feels like a chat panel
    corner_r = int(min(win_w, win_h) * 0.045)
    chat = build_chat_window(mascot, width=win_w, height=win_h,
                             mascot_name=mascot_name, brand_rgb=brand_rgb,
                             mascot_line=mascot_line, user_line=user_line,
                             industry=industry, corner_radius=corner_r)

    # Soft drop shadow
    chat_shadowed = drop_shadow(chat, offset=(0, 20), blur=36, opacity=75)

    # Position: bottom-right, inset from bezel
    cw, ch = chat_shadowed.size
    shadow_pad = 72   # blur * 2
    right_inset  = int(sw * 0.03)
    bottom_inset = int(sh * 0.04)
    px = sw - cw + shadow_pad - right_inset
    py = sh - ch + shadow_pad - bottom_inset

    # Compose chat widget onto website
    screen = web.copy()
    screen.alpha_composite(chat_shadowed, (px, py))

    # Layer: transparent canvas → screen content at coords → frame on top
    frame = laptop_frame.convert('RGBA')
    canvas = Image.new('RGBA', frame.size, (0, 0, 0, 0))
    canvas.alpha_composite(screen, (x1, y1))
    canvas.alpha_composite(frame)   # bezel on top, screen shows through hole

    # Downscale output to max 2000px width
    ow, oh = canvas.size
    if ow > 2000:
        r = 2000 / ow
        canvas = canvas.resize((2000, int(oh * r)), Image.LANCZOS)

    if out:
        canvas.save(out, optimize=True)
    return canvas


# ─────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────

def load(name, mode='RGBA'):
    return Image.open(os.path.join(HERE, name)).convert(mode)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--name',  default='Notso', help='Mascot name in chat labels')
    parser.add_argument('--color', default='#DC2626',
                        help='Brand hex color for input bar outline & chevron')
    parser.add_argument('--scale', type=float, default=0.72,
                        help='Chat-window height on laptop, as fraction of screen height')
    parser.add_argument('--suffix', default='',
                        help='Extra suffix on output filenames')
    parser.add_argument('--industry', default=None,
                        help='Industry keyword for dialogue: nutrition, health, fitness, finance, sport, education, retail, charity')
    parser.add_argument('--mascot-line', default=None,
                        help='Override mascot chat line')
    parser.add_argument('--user-line', default=None,
                        help='Override user chat line')
    parser.add_argument('--all', action='store_true',
                        help='Also generate the Yazi + lake-green sample')
    args = parser.parse_args()

    mascot  = load('mascot.png')
    # Prefer pre-processed transparent PNG frames; fall back to JPG.
    phone_f  = load('phone-frame.png')  if os.path.exists(os.path.join(HERE, 'phone-frame.png'))  else load('phone-frame.jpg')
    laptop_f = load('laptop-frame.png') if os.path.exists(os.path.join(HERE, 'laptop-frame.png')) else load('laptop-frame.jpg')
    website = load('website.png')

    def _run(name, color, suffix, industry=None,
             mascot_line=None, user_line=None):
        phone = build_phone(mascot, phone_f,
                            mascot_name=name, brand_color=color,
                            industry=industry,
                            mascot_line=mascot_line,
                            user_line=user_line,
                            out=os.path.join(OUT, f'phone{suffix}.png'))
        build_laptop(mascot, laptop_f, website,
                     mascot_name=name, brand_color=color,
                     industry=industry,
                     mascot_line=mascot_line, user_line=user_line,
                     window_scale=args.scale,
                     out=os.path.join(OUT, f'laptop{suffix}.png'))
        # Small preview for quick viewing
        pb = phone.getbbox()
        pc = phone.crop(pb)
        r = 900 / pc.size[1]
        pc.resize((int(pc.size[0]*r), 900), Image.LANCZOS)\
          .save(os.path.join(OUT, f'phone{suffix}-small.png'), optimize=True)
        print(f"  ✓ {name} / {color}  → phone{suffix}.png + laptop{suffix}.png")

    _run(args.name, args.color,
         args.suffix or f'-{args.name.lower()}',
         industry=args.industry,
         mascot_line=args.mascot_line,
         user_line=args.user_line)

    if args.all:
        # Yazi — nutrition/health app, lake green
        _run('Yazi', '#88ADA6', '-yazi', industry='nutrition')

    print(f"\n✓ Outputs in {OUT}/")


if __name__ == '__main__':
    main()
