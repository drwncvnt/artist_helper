"""Promo card generator.

Takes a square cover image plus a track name and status line, and renders a
1080x1920 (TikTok / Reels) promo card: the cover centered over a blurred,
darkened version of itself, with text above and below.

Image-generation logic is unchanged from the original standalone tool; only the
UI was restyled to the shared platform theme and the form made path-relative so
it works when served under the gateway at /promo/.
"""

import io
import os

from flask import Flask, request, render_template_string, send_file
from PIL import Image, ImageFilter, ImageEnhance, ImageDraw, ImageFont

app = Flask(__name__)

# Cap uploaded covers at a sane size (these are just square artwork images).
app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024  # 25 MB

FONT_PATH = os.path.join(os.path.dirname(__file__), "font.ttf")

HTML_TEMPLATE = """
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Promo Cards - drwncvnt</title>
  <link rel="stylesheet" href="/shared/xp.css" />
  <script defer src="https://stats.drwncvnt.com/script.js" data-website-id="e842424d-b5e8-4642-960e-46be6f5c2aa1"></script>
  <style>
    body { padding: 0; }
    .promo-wrap { max-width: 460px; margin: 24px auto; padding: 0 12px; }
    .promo-wrap .field { margin-bottom: 12px; }
  </style>
</head>
<body>
<div class="promo-wrap">
  <div class="window">
    <div class="titlebar">
      <div class="titlebar-icon"></div>
      <span class="titlebar-text">Promo Cards</span>
      <div class="titlebar-buttons">
        <a class="status-link" href="/" style="color:#fff; border-color:#6a8ec8;">&#8592; Hub</a>
      </div>
    </div>
    <div style="padding: 12px;">
      <p class="hint" style="margin-bottom: 12px;">
        Generate a release promo card (1080&times;1920) from a square cover.
      </p>
      <form class="groupbox" action="generate" method="post" enctype="multipart/form-data">
        <div class="field">
          <label class="field-label" for="cover">Track cover (square image)</label>
          <input type="file" id="cover" name="cover" accept="image/*" required />
        </div>
        <div class="field">
          <label class="field-label" for="artist_name">Artist name</label>
          <input type="text" id="artist_name" name="artist_name" placeholder="e.g. drwncvnt" maxlength="60" required />
        </div>
        <div class="field">
          <label class="field-label" for="track_name">Track name</label>
          <input type="text" id="track_name" name="track_name" placeholder="e.g. healing process" required />
        </div>
        <div class="field">
          <label class="field-label" for="status">Status line</label>
          <input type="text" id="status" name="status" value="OUT NOW!" required />
        </div>
        <div class="dialog-actions">
          <button type="submit" class="btn primary">Generate card</button>
        </div>
      </form>
    </div>
  </div>
</div>
</body>
</html>
"""


@app.route("/")
def index():
    return render_template_string(HTML_TEMPLATE)


@app.route("/generate", methods=["POST"])
def generate():
    if "cover" not in request.files:
        return "No cover uploaded", 400

    cover_file = request.files["cover"]
    artist_name = request.form.get("artist_name", "").strip() or "UNKNOWN ARTIST"
    track_name = request.form.get("track_name", "UNKNOWN TRACK").upper()
    status_text = request.form.get("status", "OUT NOW!").upper()

    original = Image.open(cover_file).convert("RGB")

    W, H = 1080, 1920

    # Blurred, darkened adaptive background from the cover itself.
    bg = original.resize((W, H), Image.Resampling.LANCZOS)
    bg = bg.filter(ImageFilter.GaussianBlur(80))
    bg = ImageEnhance.Brightness(bg).enhance(0.4)

    # Sharp centered cover.
    cover_size = 800
    fg = original.resize((cover_size, cover_size), Image.Resampling.LANCZOS)
    cover_x = (W - cover_size) // 2
    cover_y = (H - cover_size) // 2 - 100
    bg.paste(fg, (cover_x, cover_y))

    draw = ImageDraw.Draw(bg)
    try:
        font_title = ImageFont.truetype(FONT_PATH, 80)
        font_status = ImageFont.truetype(FONT_PATH, 60)
        font_artist = ImageFont.truetype(FONT_PATH, 50)
    except IOError:
        return "Error: font.ttf not found", 500

    draw.text((W / 2, cover_y - 80), artist_name, fill=(200, 200, 200), font=font_artist, anchor="mm")
    draw.text((W / 2, cover_y + cover_size + 100), track_name, fill=(255, 255, 255), font=font_title, anchor="mm")
    draw.text((W / 2, cover_y + cover_size + 220), status_text, fill=(0, 255, 100), font=font_status, anchor="mm")

    img_io = io.BytesIO()
    bg.save(img_io, "JPEG", quality=95)
    img_io.seek(0)

    return send_file(
        img_io,
        mimetype="image/jpeg",
        as_attachment=True,
        download_name=f"promo_{track_name.replace(' ', '_')}.jpg",
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5002)
