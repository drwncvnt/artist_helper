import io
import os
import base64
import logging
import shutil
import tempfile
from typing import Optional

from PIL import Image, UnidentifiedImageError
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.background import BackgroundTasks
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import HTMLResponse, FileResponse

import mutagen
from mutagen.mp3 import MP3
from mutagen.id3 import ID3, TIT2, TPE1, TALB, TPE2, TDRC, TCON, TRCK, TPOS, TSRC, TBPM, TKEY, TCOP, COMM, APIC
from mutagen.flac import FLAC, Picture
from mutagen.mp4 import MP4, MP4Cover
from mutagen.oggopus import OggOpus
from mutagen.oggvorbis import OggVorbis
from mutagen.wave import WAVE
from mutagen.aiff import AIFF

app = FastAPI(title="drwncvnt · Audio Tag & Metadata Editor")
log = logging.getLogger("tags")

MAX_AUDIO_BYTES = int(os.environ.get("MAX_AUDIO_MB", "100")) * 1024 * 1024
MAX_COVER_BYTES = int(os.environ.get("MAX_COVER_MB", "15")) * 1024 * 1024
MAX_FIELD_CHARS = 2000
Image.MAX_IMAGE_PIXELS = 25_000_000
# Only these decoders ever see an image from an upload; Pillow's many rarer
# format plugins are where most of its parser bugs live.
COVER_FORMATS = ["JPEG", "PNG", "WEBP"]
EMBEDDED_COVER_FORMATS = ["JPEG", "PNG", "GIF", "WEBP"]

ALLOWED_SUFFIXES = {".mp3", ".wav", ".aiff", ".aif", ".flac", ".m4a", ".mp4", ".aac", ".ogg", ".opus"}

HTML_PATH = os.path.join(os.path.dirname(__file__), "index.html")


def upload_suffix(upload: UploadFile) -> str:
    """The file's extension, lowercased, if it is one this tool handles. Only
    the extension of the client-supplied name is ever used on the server."""
    suffix = os.path.splitext(upload.filename or "")[1].lower()
    if suffix not in ALLOWED_SUFFIXES:
        raise HTTPException(status_code=400, detail="Unsupported file type. Use MP3, WAV, AIFF, FLAC, M4A, OGG or Opus.")
    return suffix


def download_name(upload: UploadFile, suffix: str) -> str:
    """Name for the returned file: the user's own file name without any
    directory part (browsers may send one, attackers certainly will)."""
    name = os.path.basename((upload.filename or "").replace("\\", "/")).strip()
    return name[:200] or f"tagged_track{suffix}"


async def save_upload_capped(upload_file: UploadFile, target_path: str, max_bytes: int):
    total = 0
    chunk_size = 1024 * 1024
    with open(target_path, "wb") as f:
        while True:
            chunk = await upload_file.read(chunk_size)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise HTTPException(
                    status_code=413,
                    detail=f"File exceeds maximum size limit of {max_bytes // (1024 * 1024)} MB."
                )
            f.write(chunk)


async def read_cover(cover_file: UploadFile) -> tuple[bytes, str]:
    """Reads and validates new cover art. Returns (bytes, mime); anything that
    isn't JPEG or PNG is re-encoded as PNG so every player can show it."""
    data = await cover_file.read(MAX_COVER_BYTES + 1)
    if len(data) > MAX_COVER_BYTES:
        raise HTTPException(status_code=413, detail=f"Cover artwork exceeds {MAX_COVER_BYTES // (1024*1024)} MB limit.")

    def check() -> tuple[bytes, str]:
        try:
            with Image.open(io.BytesIO(data), formats=COVER_FORMATS) as img:
                fmt = img.format
                if fmt == "JPEG":
                    img.verify()
                    return data, "image/jpeg"
                if fmt == "PNG":
                    img.verify()
                    return data, "image/png"
                out = io.BytesIO()
                img.save(out, format="PNG")
                return out.getvalue(), "image/png"
        except (UnidentifiedImageError, Image.DecompressionBombError, OSError, ValueError, SyntaxError):
            raise HTTPException(status_code=400, detail="Cover artwork must be a valid JPEG, PNG or WebP image.")

    return await run_in_threadpool(check)


def clean_field(value: Optional[str]) -> str:
    return (value or "").strip()[:MAX_FIELD_CHARS]


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "tags"}


@app.get("/", response_class=HTMLResponse)
def index():
    if not os.path.exists(HTML_PATH):
        return HTMLResponse("<h1>Audio Tag Editor UI Not Found</h1>", status_code=500)
    with open(HTML_PATH, "r", encoding="utf-8") as f:
        return HTMLResponse(f.read())


def extract_cover_art(audio_obj):
    """Extract embedded cover artwork as base64 data URI and image info."""

    def describe(data: bytes, mime: str) -> dict:
        try:
            with Image.open(io.BytesIO(data), formats=EMBEDDED_COVER_FORMATS) as img:
                w, h = img.size
        except Exception:
            w, h = None, None
        # The MIME type comes from inside the uploaded file; only pass through
        # plain image types so it can't smuggle anything else into the data URI.
        if mime not in ("image/jpeg", "image/png", "image/gif", "image/webp"):
            mime = "image/jpeg"
        b64 = base64.b64encode(data).decode("ascii")
        return {
            "data_uri": f"data:{mime};base64,{b64}",
            "mime": mime,
            "size_bytes": len(data),
            "width": w,
            "height": h,
        }

    try:
        # ID3-based (MP3, WAV, AIFF)
        if hasattr(audio_obj, "tags") and audio_obj.tags:
            for key in audio_obj.tags.keys():
                if key.startswith("APIC"):
                    apic = audio_obj.tags[key]
                    return describe(apic.data, apic.mime or "image/jpeg")

        # FLAC
        if hasattr(audio_obj, "pictures") and audio_obj.pictures:
            pic = audio_obj.pictures[0]
            return describe(pic.data, pic.mime or "image/jpeg")

        # MP4 / M4A
        if hasattr(audio_obj, "tags") and audio_obj.tags and "covr" in audio_obj.tags:
            covers = audio_obj.tags["covr"]
            if covers:
                mime = "image/png" if getattr(covers[0], "imageformat", None) == MP4Cover.FORMAT_PNG else "image/jpeg"
                return describe(bytes(covers[0]), mime)
    except Exception:
        pass
    return None


def read_tags(path: str, suffix: str) -> dict:
    """Parses the audio file at `path`. CPU-bound; called in a worker thread."""
    audio = mutagen.File(path)
    if audio is None:
        raise HTTPException(status_code=400, detail="Unsupported or corrupted audio format.")

    duration = round(getattr(audio.info, "length", 0), 2)
    bitrate = getattr(audio.info, "bitrate", None)
    if bitrate:
        bitrate = round(bitrate / 1000)
    sample_rate = getattr(audio.info, "sample_rate", None)
    channels = getattr(audio.info, "channels", None)

    title = ""
    artist = ""
    album = ""
    album_artist = ""
    year = ""
    genre = ""
    track_num = ""
    track_total = ""
    disc_num = ""
    disc_total = ""
    isrc = ""
    bpm = ""
    key = ""
    comment = ""
    copyright_text = ""

    # MP3 / ID3 tags
    if isinstance(audio, (MP3, WAVE, AIFF)) or hasattr(audio, "tags") and isinstance(audio.tags, ID3):
        tags = audio.tags or {}
        def get_text(frame_id):
            frame = tags.get(frame_id)
            if frame and hasattr(frame, "text") and frame.text:
                return str(frame.text[0])
            return ""

        title = get_text("TIT2")
        artist = get_text("TPE1")
        album = get_text("TALB")
        album_artist = get_text("TPE2")
        year = get_text("TDRC") or get_text("TYER")
        genre = get_text("TCON")
        isrc = get_text("TSRC")
        bpm = get_text("TBPM")
        key = get_text("TKEY")
        copyright_text = get_text("TCOP")

        trck = get_text("TRCK")
        if "/" in trck:
            track_num, track_total = trck.split("/", 1)
        else:
            track_num = trck

        tpos = get_text("TPOS")
        if "/" in tpos:
            disc_num, disc_total = tpos.split("/", 1)
        else:
            disc_num = tpos

        for k in tags.keys():
            if k.startswith("COMM"):
                comm = tags[k]
                if hasattr(comm, "text") and comm.text:
                    comment = str(comm.text[0])
                    break

    # FLAC / OGG / Vorbis
    elif isinstance(audio, (FLAC, OggVorbis, OggOpus)):
        tags = audio.tags or {}
        def get_first(key_name):
            vals = tags.get(key_name) or tags.get(key_name.lower()) or tags.get(key_name.upper())
            return str(vals[0]) if vals else ""

        title = get_first("TITLE")
        artist = get_first("ARTIST")
        album = get_first("ALBUM")
        album_artist = get_first("ALBUMARTIST") or get_first("ALBUM ARTIST")
        year = get_first("DATE") or get_first("YEAR")
        genre = get_first("GENRE")
        track_num = get_first("TRACKNUMBER")
        track_total = get_first("TRACKTOTAL") or get_first("TOTALTRACKS")
        disc_num = get_first("DISCNUMBER")
        disc_total = get_first("DISCTOTAL") or get_first("TOTALDISCS")
        isrc = get_first("ISRC")
        bpm = get_first("BPM")
        key = get_first("INITIALKEY") or get_first("KEY")
        comment = get_first("COMMENT") or get_first("DESCRIPTION")
        copyright_text = get_first("COPYRIGHT")

    # MP4 / M4A
    elif isinstance(audio, MP4):
        tags = audio.tags or {}
        def get_mp4(tag_name):
            val = tags.get(tag_name)
            if val:
                return str(val[0])
            return ""

        title = get_mp4("\xa9nam")
        artist = get_mp4("\xa9ART")
        album = get_mp4("\xa9alb")
        album_artist = get_mp4("aART")
        year = get_mp4("\xa9day")
        genre = get_mp4("\xa9gen")
        comment = get_mp4("\xa9cmt")
        copyright_text = get_mp4("cprt")

        trkn = tags.get("trkn")
        if trkn and isinstance(trkn[0], tuple):
            track_num = str(trkn[0][0]) if trkn[0][0] else ""
            track_total = str(trkn[0][1]) if len(trkn[0]) > 1 and trkn[0][1] else ""

        disk = tags.get("disk")
        if disk and isinstance(disk[0], tuple):
            disc_num = str(disk[0][0]) if disk[0][0] else ""
            disc_total = str(disk[0][1]) if len(disk[0]) > 1 and disk[0][1] else ""

        tmpo = tags.get("tmpo")
        if tmpo:
            bpm = str(tmpo[0])

    return {
        "format": suffix.replace(".", "").upper(),
        "duration": duration,
        "bitrate": bitrate,
        "sample_rate": sample_rate,
        "channels": channels,
        "tags": {
            "title": title,
            "artist": artist,
            "album": album,
            "album_artist": album_artist,
            "year": year,
            "genre": genre,
            "track_num": track_num,
            "track_total": track_total,
            "disc_num": disc_num,
            "disc_total": disc_total,
            "isrc": isrc,
            "bpm": bpm,
            "key": key,
            "comment": comment,
            "copyright": copyright_text,
        },
        "cover": extract_cover_art(audio),
    }


@app.post("/api/read")
async def read_audio_tags(file: UploadFile = File(...)):
    suffix = upload_suffix(file)
    fd, tmp_path = tempfile.mkstemp(suffix=suffix)
    os.close(fd)
    try:
        await save_upload_capped(file, tmp_path, MAX_AUDIO_BYTES)
        result = await run_in_threadpool(read_tags, tmp_path, suffix)
    except HTTPException:
        raise
    except Exception:
        log.exception("reading tags failed")
        raise HTTPException(status_code=400, detail="Could not read that audio file.")
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
    return {"filename": download_name(file, suffix), **result}


def write_tags(audio_path: str, fields: dict, cover_bytes, cover_mime: str, should_remove_cover: bool) -> None:
    """Writes `fields` into the file at `audio_path`. CPU/IO-bound; called in a
    worker thread."""
    title = fields["title"]
    artist = fields["artist"]
    album = fields["album"]
    album_artist = fields["album_artist"]
    year = fields["year"]
    genre = fields["genre"]
    track_num = fields["track_num"]
    track_total = fields["track_total"]
    disc_num = fields["disc_num"]
    disc_total = fields["disc_total"]
    isrc = fields["isrc"]
    bpm = fields["bpm"]
    key = fields["key"]
    comment = fields["comment"]
    copyright = fields["copyright"]

    audio = mutagen.File(audio_path)
    if audio is None:
        raise HTTPException(status_code=400, detail="Unsupported audio format.")

    # The container format is taken from the file's content, never from its
    # extension: writing ID3 into a FLAC named .mp3 (or a bare ID3 header in
    # front of a WAV) would corrupt the user's file.

    # --- MP3 / WAV / AIFF (ID3) ---
    # WAV and AIFF keep ID3 inside their own "id3 " chunk, so the tags must be
    # saved through the container object rather than prepended to the file.
    if isinstance(audio, (MP3, WAVE, AIFF)):
        if audio.tags is None:
            audio.add_tags()
        tags = audio.tags

        if title: tags.setall("TIT2", [TIT2(encoding=3, text=title)])
        else: tags.delall("TIT2")

        if artist: tags.setall("TPE1", [TPE1(encoding=3, text=artist)])
        else: tags.delall("TPE1")

        if album: tags.setall("TALB", [TALB(encoding=3, text=album)])
        else: tags.delall("TALB")

        if album_artist: tags.setall("TPE2", [TPE2(encoding=3, text=album_artist)])
        else: tags.delall("TPE2")

        if year: tags.setall("TDRC", [TDRC(encoding=3, text=year)])
        else: tags.delall("TDRC")

        if genre: tags.setall("TCON", [TCON(encoding=3, text=genre)])
        else: tags.delall("TCON")

        trck_val = f"{track_num}/{track_total}" if (track_num and track_total) else (track_num or "")
        if trck_val: tags.setall("TRCK", [TRCK(encoding=3, text=trck_val)])
        else: tags.delall("TRCK")

        tpos_val = f"{disc_num}/{disc_total}" if (disc_num and disc_total) else (disc_num or "")
        if tpos_val: tags.setall("TPOS", [TPOS(encoding=3, text=tpos_val)])
        else: tags.delall("TPOS")

        if isrc: tags.setall("TSRC", [TSRC(encoding=3, text=isrc)])
        else: tags.delall("TSRC")

        if bpm: tags.setall("TBPM", [TBPM(encoding=3, text=str(bpm))])
        else: tags.delall("TBPM")

        if key: tags.setall("TKEY", [TKEY(encoding=3, text=key)])
        else: tags.delall("TKEY")

        if copyright: tags.setall("TCOP", [TCOP(encoding=3, text=copyright)])
        else: tags.delall("TCOP")

        if comment: tags.setall("COMM", [COMM(encoding=3, lang="eng", desc="", text=comment)])
        else: tags.delall("COMM")

        if should_remove_cover:
            tags.delall("APIC")
        elif cover_bytes:
            tags.setall("APIC", [APIC(
                encoding=3,
                mime=cover_mime,
                type=3, # Front cover
                desc="Cover",
                data=cover_bytes
            )])

        audio.save(v2_version=3)

    # --- FLAC ---
    elif isinstance(audio, FLAC):

        def set_flac(k, v):
            if v: audio[k] = str(v)
            elif k in audio: del audio[k]

        set_flac("TITLE", title)
        set_flac("ARTIST", artist)
        set_flac("ALBUM", album)
        set_flac("ALBUMARTIST", album_artist)
        set_flac("DATE", year)
        set_flac("GENRE", genre)
        set_flac("TRACKNUMBER", track_num)
        set_flac("TRACKTOTAL", track_total)
        set_flac("DISCNUMBER", disc_num)
        set_flac("DISCTOTAL", disc_total)
        set_flac("ISRC", isrc)
        set_flac("BPM", bpm)
        set_flac("INITIALKEY", key)
        set_flac("COMMENT", comment)
        set_flac("COPYRIGHT", copyright)

        if should_remove_cover:
            audio.clear_pictures()
        elif cover_bytes:
            audio.clear_pictures()
            pic = Picture()
            pic.type = 3
            pic.mime = cover_mime
            pic.data = cover_bytes
            audio.add_picture(pic)

        audio.save()

    # --- MP4 / M4A ---
    elif isinstance(audio, MP4):

        def set_mp4(k, v):
            if v: audio[k] = [str(v)]
            elif k in audio: del audio[k]

        set_mp4("\xa9nam", title)
        set_mp4("\xa9ART", artist)
        set_mp4("\xa9alb", album)
        set_mp4("aART", album_artist)
        set_mp4("\xa9day", year)
        set_mp4("\xa9gen", genre)
        set_mp4("\xa9cmt", comment)
        set_mp4("cprt", copyright)

        if track_num:
            t_num = int(track_num) if track_num.isdigit() else 0
            t_tot = int(track_total) if (track_total and track_total.isdigit()) else 0
            audio["trkn"] = [(t_num, t_tot)]
        elif "trkn" in audio:
            del audio["trkn"]

        if disc_num:
            d_num = int(disc_num) if disc_num.isdigit() else 0
            d_tot = int(disc_total) if (disc_total and disc_total.isdigit()) else 0
            audio["disk"] = [(d_num, d_tot)]
        elif "disk" in audio:
            del audio["disk"]

        if bpm and bpm.isdigit():
            audio["tmpo"] = [int(bpm)]
        elif "tmpo" in audio:
            del audio["tmpo"]

        if should_remove_cover:
            if "covr" in audio: del audio["covr"]
        elif cover_bytes:
            fmt = MP4Cover.FORMAT_PNG if cover_mime == "image/png" else MP4Cover.FORMAT_JPEG
            audio["covr"] = [MP4Cover(cover_bytes, imageformat=fmt)]

        audio.save()

    # --- OGG / Opus ---
    elif isinstance(audio, (OggVorbis, OggOpus)):
        def set_ogg(k, v):
            if v: audio[k] = [str(v)]
            elif k in audio: del audio[k]

        set_ogg("TITLE", title)
        set_ogg("ARTIST", artist)
        set_ogg("ALBUM", album)
        set_ogg("ALBUMARTIST", album_artist)
        set_ogg("DATE", year)
        set_ogg("GENRE", genre)
        set_ogg("TRACKNUMBER", track_num)
        set_ogg("TRACKTOTAL", track_total)
        set_ogg("DISCNUMBER", disc_num)
        set_ogg("DISCTOTAL", disc_total)
        set_ogg("ISRC", isrc)
        set_ogg("BPM", bpm)
        set_ogg("INITIALKEY", key)
        set_ogg("COMMENT", comment)
        set_ogg("COPYRIGHT", copyright)
        audio.save()

    else:
        raise HTTPException(status_code=400, detail="Writing tags to this audio format is not supported.")


@app.post("/api/save")
async def save_audio_tags(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    cover_file: Optional[UploadFile] = File(None),
    remove_cover: Optional[str] = Form("false"),
    title: Optional[str] = Form(""),
    artist: Optional[str] = Form(""),
    album: Optional[str] = Form(""),
    album_artist: Optional[str] = Form(""),
    year: Optional[str] = Form(""),
    genre: Optional[str] = Form(""),
    track_num: Optional[str] = Form(""),
    track_total: Optional[str] = Form(""),
    disc_num: Optional[str] = Form(""),
    disc_total: Optional[str] = Form(""),
    isrc: Optional[str] = Form(""),
    bpm: Optional[str] = Form(""),
    key: Optional[str] = Form(""),
    comment: Optional[str] = Form(""),
    copyright: Optional[str] = Form(""),
):
    suffix = upload_suffix(file)
    fields = {
        "title": clean_field(title),
        "artist": clean_field(artist),
        "album": clean_field(album),
        "album_artist": clean_field(album_artist),
        "year": clean_field(year),
        "genre": clean_field(genre),
        "track_num": clean_field(track_num),
        "track_total": clean_field(track_total),
        "disc_num": clean_field(disc_num),
        "disc_total": clean_field(disc_total),
        "isrc": clean_field(isrc),
        "bpm": clean_field(bpm),
        "key": clean_field(key),
        "comment": clean_field(comment),
        "copyright": clean_field(copyright),
    }

    cover_bytes = None
    cover_mime = "image/jpeg"
    if cover_file and cover_file.filename:
        cover_bytes, cover_mime = await read_cover(cover_file)
    should_remove_cover = (remove_cover or "").lower() in ("true", "1", "yes")

    # The server-side name is fixed; the user's file name is only used for the
    # download's Content-Disposition header.
    temp_dir = tempfile.mkdtemp()
    audio_path = os.path.join(temp_dir, "input" + suffix)
    try:
        await save_upload_capped(file, audio_path, MAX_AUDIO_BYTES)
        await run_in_threadpool(write_tags, audio_path, fields, cover_bytes, cover_mime, should_remove_cover)
    except HTTPException:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise
    except Exception:
        shutil.rmtree(temp_dir, ignore_errors=True)
        log.exception("writing tags failed")
        raise HTTPException(status_code=500, detail="Could not write metadata to that file.")

    background_tasks.add_task(shutil.rmtree, temp_dir, ignore_errors=True)
    return FileResponse(
        audio_path,
        filename=download_name(file, suffix),
        media_type="application/octet-stream",
    )
