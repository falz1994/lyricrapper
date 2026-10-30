#!/usr/bin/env python3
"""
Alinea una letra contra un audio usando Google Cloud Speech-to-Text (v2).

    python3 tools/gcp_align.py cream.mp3 letra-cream.txt \
        --id cream --title "C.R.E.A.M." --artist "Wu-Tang Clan" --language en

Cómo funciona (sin magia):
  1. ffmpeg parte el audio en trozos de ~50 s (FLAC, mono, 16 kHz), que es el
     tamaño que Speech-to-Text acepta inline sin subir nada a un bucket.
  2. Cada trozo se transcribe con `enableWordTimeOffsets`: la API devuelve el
     tiempo de CADA palabra medido en el audio.
  3. Esa transcripción se alinea palabra por palabra con tu letra (la misma
     lógica de tools/align.py: difflib.SequenceMatcher + interpolación).
  4. Se escribe data/tracks/<id>.json y se agrega a data/tracks.json.

Credenciales: --key (por defecto /home/devni/GCP-Connection/key.json) o la
variable GOOGLE_APPLICATION_CREDENTIALS.
"""
from __future__ import annotations

import argparse
import base64
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

import align as aligner  # noqa: E402
import songkit  # noqa: E402

DEFAULT_KEY = "/home/devni/GCP-Connection/key.json"
SCOPE = "https://www.googleapis.com/auth/cloud-platform"


# ------------------------------------------------------------------ auth/API

def access_token(key_path: Path) -> tuple[str, str]:
    """Devuelve (token, project_id) usando la service account."""
    try:
        from google.auth.transport.requests import Request
        from google.oauth2 import service_account
    except ImportError:
        sys.exit("Falta google-auth:  pip install --target tools/pylib google-auth")

    if not key_path.exists():
        sys.exit(f"No existe la clave de servicio: {key_path}")

    info = json.loads(key_path.read_text(encoding="utf-8"))
    creds = service_account.Credentials.from_service_account_file(
        str(key_path), scopes=[SCOPE]
    )
    creds.refresh(Request())
    return creds.token, info.get("project_id", "")


def create_phrase_set(token: str, project: str, location: str,
                      lines: list[str], phrase_set_id: str) -> str:
    """Sube la letra como PhraseSet (adaptación del reconocimiento)."""
    base = (f"https://{location}-speech.googleapis.com/v2/projects/{project}"
            f"/locations/{location}/phraseSets")
    name = f"projects/{project}/locations/{location}/phraseSets/{phrase_set_id}"

    body = {
        "phrases": [
            {"value": line[:100], "boost": 20.0}
            for line in lines
            if line.strip()
        ]
    }
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.post(f"{base}?phraseSetId={phrase_set_id}",
                      headers=headers, json=body, timeout=120)
    if r.status_code not in (200, 409):
        # ya existe -> PATCH para actualizarlo
        r = requests.patch(f"{base}/{phrase_set_id}",
                           headers=headers, json=body, timeout=120)
        if r.status_code != 200:
            sys.exit(f"No se pudo crear el PhraseSet ({r.status_code}):\n{r.text[:800]}")
    return name


def recognize_chunk(token: str, project: str, location: str, audio: bytes,
                    language: str, model: str,
                    adaptation: str | None = None) -> list[dict]:
    """Transcribe un trozo y devuelve [{word, start, end}] en tiempo del trozo."""
    url = (f"https://{location}-speech.googleapis.com/v2/projects/{project}"
           f"/locations/{location}/recognizers/_:recognize")
    config = {
        "autoDecodingConfig": {},
        "languageCodes": [language],
        "model": model,
        "features": {
            "enableWordTimeOffsets": True,
            "enableWordConfidence": True,
        },
    }
    if adaptation:
        config["adaptation"] = {"phraseSets": [{"phraseSet": adaptation}]}
    payload = {
        "config": config,
        "content": base64.b64encode(audio).decode("ascii"),
    }

    last = ""
    for attempt in range(3):
        r = requests.post(url, headers={"Authorization": f"Bearer {token}"},
                          json=payload, timeout=180)
        if r.status_code != 200:
            last = f"{r.status_code}: {r.text[:800]}"
            continue

        words: list[dict] = []
        for result in r.json().get("results", []):
            for alt in result.get("alternatives", [])[:1]:
                for w in alt.get("words", []):
                    token_txt = (w.get("word") or "").strip()
                    if not token_txt:
                        continue
                    words.append({
                        "word": token_txt,
                        "start": _seconds(w.get("startOffset", "0s")),
                        "end": _seconds(w.get("endOffset", "0s")),
                    })
        if words:
            return words
        last = "respuesta vacía"
    print(f"    (aviso: trozo sin palabras tras 3 intentos — {last})", file=sys.stderr)
    return []


def _seconds(value: str) -> float:
    """'12.345s' -> 12.345"""
    try:
        return float(str(value).rstrip("s"))
    except ValueError:
        return 0.0


def local_realign(detected: list[dict], lyric_tokens: list[list[str]],
                  starts: list[float], coverage: list[float],
                  duration: float, weak: float = 0.25,
                  factor: float = 3.0) -> list[float]:
    """Realinea sólo las zonas rotas, contra las palabras que suenan ahí.

    El problema típico: un estribillo repetido se empareja con su SEGUNDA
    aparición, y las líneas de la primera quedan sin tiempo. Al re-alinear
    únicamente dentro de la ventana rota (con las palabras de ese tramo), el
    desfase desaparece.
    """
    n = len(starts)
    if n == 0 or not duration:
        return starts

    durations = [(starts[i + 1] - starts[i]) if i + 1 < n else (duration - starts[i])
                 for i in range(n)]
    strong = sorted(d for i, d in enumerate(durations) if coverage[i] >= 0.5)
    median = strong[len(strong) // 2] if strong else 2.5

    broken = [coverage[i] < weak or durations[i] > factor * median for i in range(n)]

    i = 0
    while i < n:
        if not broken[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and broken[j + 1]:
            j += 1

        left = starts[i - 1] if i > 0 else 0.0
        right = starts[j + 1] if j + 1 < n else duration
        window = [w for w in detected if left <= w["start"] < right]

        if window:
            per_line, hits = aligner.align_words(window, lyric_tokens[i : j + 1])
            for k, times in enumerate(per_line):
                found = [t for t in times if t]
                tokens = lyric_tokens[i + k]
                coverage[i + k] = (sum(1 for h in hits[k] if h) / len(tokens)
                                   if tokens else 0.0)
                if found:
                    starts[i + k] = round(min(max(found[0][0], left), right), 3)

            for k in range(i + 1, j + 1):
                starts[k] = max(starts[k], starts[k - 1])

        i = j + 1
    return starts


def respace_weak_runs(lyric_tokens: list[list[str]], starts: list[float],
                      coverage: list[float], duration: float,
                      weak: float = 0.2, min_run: int = 4) -> list[int]:
    """Reparte los bloques que Speech-to-Text no oyó entre sus dos anclas.

    Los estribillos repetidos son justo lo que el reconocimiento suele saltarse
    (o reconoce una sola vez). Aquí se detectan las rachas de líneas con poca
    coincidencia y se distribuyen proporcionalmente al número de palabras entre
    la última línea fiable y la siguiente. Devuelve los índices estimados.
    """
    n = len(starts)
    if n == 0 or not duration:
        return []

    estimated: list[int] = []
    i = 0
    while i < n:
        if coverage[i] >= weak:
            i += 1
            continue
        j = i
        while j + 1 < n and coverage[j + 1] < weak:
            j += 1
        run = j - i + 1
        if run >= min_run:
            left = starts[i - 1] if i > 0 else 0.0
            right = starts[j + 1] if j + 1 < n else duration
            span = right - left
            weights = [max(1, len(t)) for t in lyric_tokens[i : j + 1]]
            total = sum(weights)
            acc = 0
            for k, w in enumerate(weights):
                starts[i + k] = round(left + span * acc / total, 3)
                acc += w
                estimated.append(i + k)
        i = j + 1
    return estimated


# ------------------------------------------------------------------- trocear

def chunk_audio(audio: Path, out_dir: Path, seconds: int) -> list[tuple[Path, float]]:
    """Parte el audio en FLAC mono 16 kHz. Devuelve [(ruta, desplazamiento)]."""
    pattern = out_dir / "chunk_%03d.flac"
    cmd = [
        "ffmpeg", "-v", "error", "-y", "-i", str(audio),
        "-ac", "1", "-ar", "16000",
        "-f", "segment", "-segment_time", str(seconds),
        "-c:a", "flac", str(pattern),
    ]
    subprocess.run(cmd, check=True)
    chunks = sorted(out_dir.glob("chunk_*.flac"))
    if not chunks:
        sys.exit("ffmpeg no generó ningún trozo: ¿el audio tiene pista de sonido?")
    return [(c, i * float(seconds)) for i, c in enumerate(chunks)]


# ---------------------------------------------------------------------- main

def main() -> None:
    ap = argparse.ArgumentParser(
        description="Alinea una letra con Google Cloud Speech-to-Text (v2).")
    ap.add_argument("audio", type=Path, help="archivo de audio (mp3, m4a, wav…)")
    ap.add_argument("lyrics", type=Path, nargs="?",
                    help="texto plano, una línea por renglón")
    ap.add_argument("--id")
    ap.add_argument("--title")
    ap.add_argument("--artist", default="")
    ap.add_argument("--album", default="")
    ap.add_argument("--language", default="en", help="en, en-US, es… (def. en)")
    ap.add_argument("--key", type=Path, default=Path(DEFAULT_KEY))
    ap.add_argument("--location", default="us-central1")
    ap.add_argument("--model", default="long",
                    help="long | short | chirp (def. long)")
    ap.add_argument("--chunk", type=int, default=50,
                    help="segundos por trozo (def. 50; el límite inline es 1 min)")
    ap.add_argument("--offset", type=float, default=0.0,
                    help="desplaza todos los tiempos (s)")
    ap.add_argument("--min-coverage", type=float, default=0.34)
    ap.add_argument("--probe", action="store_true",
                    help="sólo transcribe el primer trozo y muestra las palabras")
    ap.add_argument("--no-adapt", action="store_true",
                    help="no subir la letra como PhraseSet (menos preciso)")
    ap.add_argument("--words-cache", type=Path,
                    help="guarda/reutiliza la transcripción (JSON con las palabras)")
    ap.add_argument("--no-respace", action="store_true",
                    help="no repartir los estribillos que la API no reconoció")
    ap.add_argument("--overrides", type=Path,
                    help='JSON [{"line": 96, "start": 217.3}] con tiempos a mano')
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()

    if not args.audio.exists():
        sys.exit(f"No existe el audio: {args.audio}")

    language = args.language
    if "-" not in language:
        language = {"en": "en-US", "es": "es-ES"}.get(language, language)

    token, project = access_token(args.key)
    print(f"· credenciales ok (proyecto {project})", file=sys.stderr)

    duration = songkit.duration_of(args.audio)

    lines: list[str] = []
    if args.lyrics:
        if not args.lyrics.exists():
            sys.exit(f"No existe la letra: {args.lyrics}")
        lines = aligner.read_lines(args.lyrics)
        if not lines:
            sys.exit("La letra está vacía.")

    adaptation = None
    if lines and not args.no_adapt:
        phrase_id = songkit.slug(f"letra-{args.audio.stem}")[:30]
        adaptation = create_phrase_set(token, project, args.location, lines, phrase_id)
        print(f"· adaptación con la letra ({len(lines)} frases): {phrase_id}",
              file=sys.stderr)

    detected: list[dict] = []
    cache = args.words_cache
    if cache and cache.exists():
        detected = json.loads(cache.read_text(encoding="utf-8"))
        print(f"· transcripción reutilizada de {cache} ({len(detected)} palabras)",
              file=sys.stderr)
    else:
        tmp = Path(tempfile.mkdtemp(prefix="gcp_stt_"))
        try:
            chunks = chunk_audio(args.audio, tmp, args.chunk)
            if args.probe:
                chunks = chunks[:1]
            print(f"· {len(chunks)} trozo(s) de ≤{args.chunk}s", file=sys.stderr)

            for n, (path, shift) in enumerate(chunks, 1):
                data = path.read_bytes()
                words = recognize_chunk(token, project, args.location, data,
                                        language, args.model, adaptation)
                for w in words:
                    w["start"] += shift
                    w["end"] += shift
                detected.extend(words)
                print(f"  trozo {n}/{len(chunks)}: {len(words)} palabras",
                      file=sys.stderr)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

        if cache:
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps(detected, ensure_ascii=False, indent=1),
                             encoding="utf-8")
            print(f"· transcripción guardada en {cache}", file=sys.stderr)

    if args.probe:
        for w in detected:
            print(f"{w['start']:7.2f} {w['end']:7.2f} {w['word']}")
        return

    if not detected:
        sys.exit("Speech-to-Text no devolvió palabras.")
    if not lines:
        sys.exit("Falta la letra: pasa un .txt con una línea por renglón.")

    lyric_tokens = [aligner.tokenize(line) for line in lines]
    print(f"· {len(lines)} líneas / {sum(len(t) for t in lyric_tokens)} palabras "
          f"en la letra", file=sys.stderr)

    per_line, per_line_hits = aligner.align_words(detected, lyric_tokens)

    starts: list[float] = []
    coverage: list[float] = []
    for li, tokens in enumerate(lyric_tokens):
        times = [t for t in per_line[li] if t]
        if not tokens:
            starts.append(starts[-1] if starts else 0.0)
            coverage.append(0.0)
            continue
        first = times[0][0] if times else (starts[-1] if starts else 0.0)
        coverage.append(sum(1 for h in per_line_hits[li] if h) / len(tokens))
        starts.append(max(0.0, first + args.offset))

    for i in range(1, len(starts)):
        starts[i] = max(starts[i], starts[i - 1])
    if duration:
        starts = [min(s, duration) for s in starts]

    estimated: set[int] = set()
    if not args.no_respace:
        clean = [w for w in detected if (w["end"] - w["start"]) <= 3.0]
        starts = local_realign(clean, lyric_tokens, starts, coverage, duration)
        estimated = set(respace_weak_runs(lyric_tokens, starts, coverage, duration))

    fixed: set[int] = set()
    if args.overrides and args.overrides.exists():
        for item in json.loads(args.overrides.read_text(encoding="utf-8")):
            idx = int(item["line"]) - 1
            if 0 <= idx < len(starts):
                starts[idx] = float(item["start"])
                fixed.add(idx)
                estimated.discard(idx)
        for i in range(1, len(starts)):
            starts[i] = max(starts[i], starts[i - 1])

    ends = starts[1:] + [duration or (starts[-1] + 5.0)]

    track_id = args.id or songkit.slug(args.audio.stem)
    _, audio_rel = songkit.copy_audio(args.audio)
    track = {
        "id": track_id,
        "title": args.title or args.audio.stem,
        "artist": args.artist,
        "album": args.album,
        "kicker": "Alineado con Google Speech-to-Text",
        "audio": audio_rel,
        "duration": round(duration, 3),
        "bpm": None,
        "language": args.language,
        "lines": [
            {"start": round(starts[i], 3), "end": round(ends[i], 3), "text": lines[i]}
            for i in range(len(lines))
        ],
    }

    print("\n  #   inicio   fin      cobertura  línea", file=sys.stderr)
    print("  " + "-" * 68, file=sys.stderr)
    weak = []
    for i, line in enumerate(lines):
        cov = coverage[i]
        flag = "  ⚠" if cov < args.min_coverage else ""
        if flag:
            weak.append(i + 1)
        mark = " ≈" if i in estimated else ""
        print(f"  {i + 1:>3}  {starts[i]:>7.2f}  {ends[i]:>7.2f}   {cov * 100:>5.0f} %   "
              f"{line[:40]}{flag}{mark}", file=sys.stderr)
    if estimated:
        print(f"\n  ≈ {len(estimated)} líneas repartidas proporcionalmente entre sus "
              f"vecinas (Speech-to-Text no las oyó: son estribillos repetidos).",
              file=sys.stderr)
    if weak:
        print(f"\n  Aviso: revisa las líneas {weak[:12]}"
              f"{'…' if len(weak) > 12 else ''} (poca coincidencia con el audio).",
              file=sys.stderr)

    out = args.out or (ROOT / "data" / "tracks" / f"{track_id}.json")
    songkit.write_track(track, out)
    songkit.update_index({
        "id": track_id,
        "title": track["title"],
        "artist": track["artist"],
        "file": f"data/tracks/{track_id}.json",
    })
    print(f"\n  escrito: {out}", file=sys.stderr)
    print(f"  reproductor → http://localhost:8088/?track={track_id}", file=sys.stderr)


if __name__ == "__main__":
    main()
