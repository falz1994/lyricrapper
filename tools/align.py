#!/usr/bin/env python3
"""
Alinea una letra escrita contra un audio y genera el JSON de tiempos.

    python3 tools/align.py cancion.mp3 letra.txt --id mi-tema \
        --title "Mi tema" --artist "Alguien" --language es

Cómo funciona (sin magia):
  1. Whisper (faster-whisper) transcribe el audio y da el tiempo de CADA palabra.
  2. La transcripción se alinea palabra por palabra con la letra que tú aportas
     (difflib.SequenceMatcher: coincidencias, inserciones y omisiones).
  3. Las palabras que no se reconocieron se interpolan entre sus vecinas.
  4. El inicio de una línea = tiempo de su primera palabra; el fin = inicio de
     la línea siguiente.

Límites honestos:
  * Whisper acierta ±100 ms en condiciones limpias; con la instrumental encima
    del rapeo se equivoca más. Para un instrumental, pásale el stem de voz
    (demucs --two-stems=vocals) y la alineación mejora muchísimo.
  * Si la letra no coincide con lo que suena, la alineación se degrada: el
    informe indica qué líneas quedaron con poca coincidencia.
  * Para un ajuste "clavado" al oído, el estudio sync.html es más preciso.

Requisitos: faster-whisper (ver tools/requirements.txt). El modelo se descarga
la primera vez en tools/models/.
"""
from __future__ import annotations

import argparse
import difflib
import json
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MODEL_DIR = ROOT / "tools" / "models"

TOKEN_RE = re.compile(r"[^\W_]+(?:['’][^\W_]+)?", re.UNICODE)


# --------------------------------------------------------------------- texto

def normalize(token: str) -> str:
    """minúsculas, sin acentos, sin puntuación: la forma que se compara."""
    token = unicodedata.normalize("NFD", token.lower())
    token = "".join(ch for ch in token if unicodedata.category(ch) != "Mn")
    token = token.replace("’", "'")
    return token.strip("'-")


def tokenize(text: str) -> list[str]:
    return [normalize(t) for t in TOKEN_RE.findall(text) if normalize(t)]


def read_lines(path: Path) -> list[str]:
    lines = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line and not line.startswith("#"):
            lines.append(line)
    return lines


# ------------------------------------------------------------------ alinear

def align_words(detected: list[dict], lyric_tokens: list[list[str]]):
    """
    Devuelve (tiempos_por_línea, coincidencias_por_línea).

    tiempos[i][k]   = (start, end) de la palabra k de la línea i (interpolado si
                      Whisper no la reconoció)
    coincidencias[i][k] = True si esa palabra se emparejó de verdad con el audio
    """
    flat: list[str] = []
    index: list[tuple[int, int]] = []
    for li, tokens in enumerate(lyric_tokens):
        for wi, tok in enumerate(tokens):
            flat.append(tok)
            index.append((li, wi))

    times: list[tuple | None] = [None] * len(flat)
    matched = [False] * len(flat)

    if detected:
        det_tokens = [normalize(d["word"]) for d in detected]
        matcher = difflib.SequenceMatcher(None, det_tokens, flat, autojunk=False)
        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
            if tag == "equal":
                for k in range(i2 - i1):
                    d = detected[i1 + k]
                    times[j1 + k] = (float(d["start"]), float(d["end"]))
                    matched[j1 + k] = True

    interpolate(times)

    out: list[list[tuple | None]] = []
    hits: list[list[bool]] = []
    for li in range(len(lyric_tokens)):
        idx = [i for i, (l, _) in enumerate(index) if l == li]
        out.append([times[i] for i in idx])
        hits.append([matched[i] for i in idx])
    return out, hits


def interpolate(times: list[tuple | None]) -> None:
    """Rellena huecos lineales entre palabras conocidas (in situ)."""
    n = len(times)
    known = [i for i, t in enumerate(times) if t]
    if not known:
        return

    first = known[0]
    if first > 0:
        start = max(0.0, times[first][0] - 0.35 * first)
        for i in range(first):
            times[i] = (start, start)

    for a, b in zip(known, known[1:]):
        if b - a <= 1:
            continue
        t0 = times[a][1]
        t1 = times[b][0]
        for k in range(1, b - a):
            t = t0 + (t1 - t0) * (k / (b - a))
            times[a + k] = (t, t)

    last = known[-1]
    if last < n - 1:
        end = times[last][1] + 0.35 * (n - 1 - last)
        for i in range(last + 1, n):
            times[i] = (end, end)


# --------------------------------------------------------------- transcripción

def transcribe(audio: Path, model_name: str, language: str | None,
               model_dir: Path, compute_type: str, use_vad: bool = False) -> tuple[list[dict], float]:
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.exit(
            "Falta faster-whisper.\n"
            "  pip install --target tools/pylib -r tools/requirements.txt\n"
            "y vuelve a ejecutar con PYTHONPATH=tools/pylib"
        )

    model_dir.mkdir(parents=True, exist_ok=True)
    print(f"· cargando modelo {model_name} ({compute_type}, cpu)…", file=sys.stderr)
    model = WhisperModel(model_name, device="cpu", compute_type=compute_type,
                         download_root=str(model_dir))

    print(f"· transcribiendo {audio.name}…", file=sys.stderr)
    # vad_filter=False a propósito: con VAD, Whisper estira la primera palabra
    # de cada segmento hacia el silencio anterior y arruina el inicio de línea.
    segments, info = model.transcribe(
        str(audio),
        language=language,
        word_timestamps=True,
        vad_filter=use_vad,
        vad_parameters={"min_silence_duration_ms": 300} if use_vad else None,
        beam_size=5,
        condition_on_previous_text=False,
    )

    words: list[dict] = []
    for seg in segments:
        for w in seg.words or []:
            token = w.word.strip()
            if token:
                words.append({"word": token, "start": float(w.start), "end": float(w.end)})

    duration = float(getattr(info, "duration", 0.0) or 0.0)
    print(f"· {len(words)} palabras detectadas en {duration:.1f} s", file=sys.stderr)
    return words, duration


# ---------------------------------------------------------------------- main

def main() -> None:
    ap = argparse.ArgumentParser(description="Genera los tiempos por línea de una canción.")
    ap.add_argument("audio", type=Path, help="archivo de audio (mp3, m4a, wav…)")
    ap.add_argument("lyrics", type=Path, help="texto plano, una línea por renglón")
    ap.add_argument("--id", help="id del track (por defecto, el nombre del audio)")
    ap.add_argument("--title")
    ap.add_argument("--artist", default="")
    ap.add_argument("--album", default="")
    ap.add_argument("--language", default=None, help="es, en… (vacío = autodetectar)")
    ap.add_argument("--model", default="base", help="tiny | base | small | medium (def. base)")
    ap.add_argument("--compute-type", default="int8", help="int8 | int8_float32 | float32")
    ap.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL_DIR)
    ap.add_argument("--offset", type=float, default=0.0,
                    help="desplaza todos los tiempos (s); negativo si la letra va adelantada")
    ap.add_argument("--out", type=Path, help="JSON de salida")
    ap.add_argument("--min-coverage", type=float, default=0.34,
                    help="marca líneas por debajo de esta coincidencia (0-1)")
    ap.add_argument("--vad", action="store_true",
                    help="filtrar silencios (útil en audios con mucho instrumental, "
                         "pero desplaza el inicio de cada segmento)")
    ap.add_argument("--dry-run", action="store_true", help="no escribe nada, sólo informa")
    ap.add_argument("--quiet", action="store_true",
                    help="no repite los pasos siguientes (cuando lo llama add_song.py)")
    args = ap.parse_args()

    if not args.audio.exists():
        sys.exit(f"No existe el audio: {args.audio}")
    if not args.lyrics.exists():
        sys.exit(f"No existe la letra: {args.lyrics}")

    lines = read_lines(args.lyrics)
    if not lines:
        sys.exit("La letra está vacía.")

    lyric_tokens = [tokenize(line) for line in lines]
    total_tokens = sum(len(t) for t in lyric_tokens)
    print(f"· {len(lines)} líneas / {total_tokens} palabras en la letra", file=sys.stderr)

    detected, duration = transcribe(args.audio, args.model, args.language,
                                    args.model_dir, args.compute_type, args.vad)
    if not detected:
        sys.exit("Whisper no detectó voz. Prueba con el stem de voces o con --model small.")

    per_line, per_line_hits = align_words(detected, lyric_tokens)

    # tiempos por línea
    starts: list[float] = []
    coverage: list[float] = []
    for li, tokens in enumerate(lyric_tokens):
        times = [t for t in per_line[li] if t]
        if not tokens:
            starts.append(starts[-1] if starts else 0.0)
            coverage.append(0.0)
            continue
        first = times[0][0] if times else (starts[-1] if starts else 0.0)
        matched = sum(1 for hit in per_line_hits[li] if hit)
        coverage.append(matched / len(tokens))
        starts.append(max(0.0, first + args.offset))

    # monotónico y dentro del audio
    for i in range(1, len(starts)):
        if starts[i] < starts[i - 1]:
            starts[i] = starts[i - 1]
    if duration:
        starts = [min(s, duration) for s in starts]

    ends = starts[1:] + [duration or (starts[-1] + 5.0)]

    track_id = args.id or re.sub(r"[^a-z0-9]+", "-", args.audio.stem.lower()).strip("-")
    track = {
        "id": track_id,
        "title": args.title or args.audio.stem,
        "artist": args.artist,
        "album": args.album,
        "kicker": f"Alineado automáticamente ({args.model})",
        "audio": f"assets/audio/{args.audio.name}",
        "duration": round(duration, 3),
        "bpm": None,
        "language": args.language or "",
        "lines": [
            {"start": round(starts[i], 3), "end": round(ends[i], 3), "text": lines[i]}
            for i in range(len(lines))
        ],
    }

    # informe
    print("\n  #   inicio   fin      cobertura  línea", file=sys.stderr)
    print("  " + "-" * 68, file=sys.stderr)
    weak = []
    for i, line in enumerate(lines):
        cov = coverage[i]
        flag = "  ⚠" if cov < args.min_coverage else ""
        if flag:
            weak.append(i + 1)
        print(f"  {i + 1:>2}  {starts[i]:>7.2f}  {ends[i]:>7.2f}   {cov * 100:>5.0f} %   "
              f"{line[:40]}{flag}", file=sys.stderr)
    if weak:
        print(f"\n  Aviso: revisa las líneas {weak[:12]}"
              f"{'…' if len(weak) > 12 else ''} (poca coincidencia con el audio).", file=sys.stderr)

    if args.dry_run:
        print("\n  --dry-run: no se escribió nada.", file=sys.stderr)
        return

    out = args.out or (ROOT / "data" / "tracks" / f"{track_id}.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(track, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\n  escrito: {out}", file=sys.stderr)
    if not args.quiet:
        print("  agrega la entrada a data/tracks.json y copia el audio a assets/audio/",
              file=sys.stderr)


if __name__ == "__main__":
    main()
