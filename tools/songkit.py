#!/usr/bin/env python3
"""
Utilidades compartidas por las herramientas de línea de comandos.

    add_song.py   → audio + letra  → canción en el proyecto
    sync_tool.py  → fuente → audio + letra → canción en el proyecto

Aquí viven las cosas que ambos necesitan: rutas, slug, duración, índice,
alineación con Whisper y transcripción (para sacar la letra del propio audio).
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import unicodedata
import urllib.request
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent.parent
AUDIO_DIR = ROOT / "assets" / "audio"
TRACKS_DIR = ROOT / "data" / "tracks"
INDEX = ROOT / "data" / "tracks.json"
PYLIB = ROOT / "tools" / "pylib"
MODELS = ROOT / "tools" / "models"
ALIGN = ROOT / "tools" / "align.py"

AUDIO_EXT = {".mp3", ".m4a", ".aac", ".ogg", ".opus", ".wav", ".flac"}
MAX_DOWNLOAD_MB = 120

YOUTUBE_RE = re.compile(
    r"(?:youtube\.com/(?:watch\?(?:.*&)?v=|embed/|shorts/|live/)|youtu\.be/)"
    r"([A-Za-z0-9_-]{6,})"
)


# ------------------------------------------------------------------ básicos

def slug(text: str) -> str:
    text = unicodedata.normalize("NFD", text.lower())
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")[:60] or "cancion"


def safe_audio_name(path: Path) -> str:
    stem = re.sub(r"[^A-Za-z0-9 ._-]+", "_", path.stem).strip() or "audio"
    return f"{stem}{path.suffix.lower()}"


def duration_of(path: Path) -> float:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(path)],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        return round(float(out), 3)
    except (subprocess.CalledProcessError, ValueError, FileNotFoundError):
        return 0.0


def read_lines(path: Path) -> list[str]:
    return [
        line.strip()
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]


def update_index(entry: dict) -> None:
    try:
        index = json.loads(INDEX.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        index = {"tracks": []}
    tracks = [t for t in index.get("tracks", []) if t.get("id") != entry["id"]]
    tracks.append(entry)
    index["tracks"] = tracks
    INDEX.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_track(track: dict, out_json: Path) -> Path:
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(track, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return out_json


def copy_audio(src: Path) -> tuple[Path, str]:
    """Copia el audio a assets/audio/ con nombre seguro. Devuelve (ruta, ruta relativa)."""
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    dest = AUDIO_DIR / safe_audio_name(src)
    if src.resolve() != dest.resolve():
        shutil.copy2(src, dest)
    return dest, f"assets/audio/{dest.name}"


def draft_track(audio_rel: str, lines: list[str], duration: float,
                track_id: str, title: str, artist: str, album: str) -> dict:
    """Reparto parejo: sirve para ver la letra en el reproductor y corregir luego."""
    n = max(1, len(lines))
    step = (duration or n * 3.0) / n
    return {
        "id": track_id,
        "title": title,
        "artist": artist,
        "album": album,
        "kicker": "Borrador — falta ajustar los tiempos",
        "audio": audio_rel,
        "duration": duration,
        "bpm": None,
        "language": "",
        "lines": [
            {"start": round(i * step, 3), "end": round((i + 1) * step, 3), "text": text}
            for i, text in enumerate(lines)
        ],
    }


# ------------------------------------------------------------------ whisper

def has_whisper() -> bool:
    try:
        out = subprocess.run(
            [sys.executable, "-c", "import faster_whisper"],
            capture_output=True,
            env={**os.environ, "PYTHONPATH": str(PYLIB)},
        )
        return out.returncode == 0
    except OSError:
        return False


def align_with_whisper(audio: Path, lyrics: Path, out_json: Path, *,
                       track_id: str, title: str, artist: str, album: str,
                       model: str = "base", language: str | None = None,
                       offset: float = 0.0) -> int:
    cmd = [
        sys.executable, str(ALIGN), str(audio), str(lyrics),
        "--id", track_id, "--title", title, "--artist", artist, "--album", album,
        "--model", model, "--offset", str(offset), "--out", str(out_json), "--quiet",
    ]
    if language:
        cmd += ["--language", language]
    return subprocess.run(cmd, env={**os.environ, "PYTHONPATH": str(PYLIB)}).returncode


def transcribe_lines(audio: Path, *, model: str = "base", language: str | None = None,
                     min_words: int = 4) -> tuple[list[dict], float]:
    """
    Saca la letra del propio audio y devuelve [{start, end, text}] por línea.

    No consulta ningún sitio de letras: transcribe. Se parte en líneas por
    puntuación cuando el tramo es largo, repartiendo el tiempo por palabras.
    """
    if str(PYLIB) not in sys.path:
        sys.path.insert(0, str(PYLIB))
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        raise SystemExit(
            "Falta faster-whisper:\n"
            "  pip install --target tools/pylib -r tools/requirements.txt"
        )

    MODELS.mkdir(parents=True, exist_ok=True)
    print(f"· cargando modelo {model} (int8, cpu)…", file=sys.stderr)
    engine = WhisperModel(model, device="cpu", compute_type="int8", download_root=str(MODELS))

    print(f"· transcribiendo {audio.name}…", file=sys.stderr)
    segments, info = engine.transcribe(
        str(audio),
        language=language,
        word_timestamps=True,
        vad_filter=False,
        beam_size=5,
        condition_on_previous_text=False,
    )

    lines: list[dict] = []
    for seg in segments:
        words = [w for w in (seg.words or []) if w.word.strip()]
        if not words:
            continue
        group: list = []
        for w in words:
            group.append(w)
            closes = w.word.strip().endswith((".", "?", "!", "…"))
            if closes and len(group) >= min_words:
                lines.append(_line_from_words(group))
                group = []
        if group:
            lines.append(_line_from_words(group))

    duration = float(getattr(info, "duration", 0.0) or 0.0)
    lines = [ln for ln in lines if ln["text"]]
    for i, ln in enumerate(lines):
        nxt = lines[i + 1]["start"] if i + 1 < len(lines) else (duration or ln["end"])
        ln["end"] = round(max(ln["start"], min(ln["end"], nxt)), 3)

    print(f"· {len(lines)} líneas transcritas", file=sys.stderr)
    return lines, round(duration, 3)


def _line_from_words(words: list) -> dict:
    text = " ".join(w.word.strip() for w in words).strip()
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    return {
        "start": round(float(words[0].start), 3),
        "end": round(float(words[-1].end), 3),
        "text": text,
    }


# ------------------------------------------------------- fuentes (url/archivo)

def youtube_id(url: str) -> str | None:
    m = YOUTUBE_RE.search(url)
    return m.group(1) if m else None


def youtube_meta(video_id: str) -> dict:
    """Metadatos públicos vía oEmbed (sin claves, sin descargar nada)."""
    endpoint = (
        "https://www.youtube.com/oembed?format=json&url="
        f"https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D{video_id}"
    )
    try:
        req = urllib.request.Request(endpoint, headers={"User-Agent": "lyric-rapper/1.0"})
        with urllib.request.urlopen(req, timeout=15) as res:
            return json.loads(res.read().decode("utf-8", "replace"))
    except Exception:
        return {}


def download_audio(url: str) -> Path:
    """
    Descarga un archivo de audio servido en una URL directa (tu hosting, una
    fuente con licencia abierta, tu propio servidor…). No acepta páginas web:
    exige que la URL termine en una extensión de audio.
    """
    parsed = urlparse(url)
    name = unquote(Path(parsed.path).name)
    suffix = Path(name).suffix.lower()
    if suffix not in AUDIO_EXT:
        raise ValueError(
            f"la URL no apunta a un archivo de audio (extensión {suffix or 'desconocida'}).\n"
            f"  se aceptan: {', '.join(sorted(AUDIO_EXT))}"
        )

    print(f"· descargando {url}", file=sys.stderr)
    req = urllib.request.Request(url, headers={"User-Agent": "lyric-rapper/1.0"})
    limit = MAX_DOWNLOAD_MB * 1024 * 1024
    with urllib.request.urlopen(req, timeout=120) as res:
        ctype = (res.headers.get("Content-Type") or "").split(";")[0].strip()
        if ctype and not (ctype.startswith("audio/") or ctype == "application/octet-stream"):
            raise ValueError(f"el servidor devolvió {ctype}, no audio")
        data = res.read(limit + 1)
    if len(data) > limit:
        raise ValueError(f"el archivo supera {MAX_DOWNLOAD_MB} MB")

    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    dest = AUDIO_DIR / re.sub(r"[^A-Za-z0-9 ._-]+", "_", name)
    if dest.exists() and dest.stat().st_size == len(data):
        print(f"· ya estaba: {dest.relative_to(ROOT)}", file=sys.stderr)
        return dest
    dest.write_bytes(data)
    print(f"· guardado en {dest.relative_to(ROOT)} ({len(data) / 1024 / 1024:.1f} MB)", file=sys.stderr)
    return dest
