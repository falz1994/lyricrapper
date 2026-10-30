#!/usr/bin/env python3
"""
Convierte los audios del proyecto a Opus 64 kbps (WebM) y deja el mp3 como
alternativa, para que la web pese ~3 veces menos al servirla desde Vercel.

    python3 tools/optimize_audio.py            # convierte lo que falte
    python3 tools/optimize_audio.py --force    # rehace todo
    python3 tools/optimize_audio.py --dry-run  # sólo dice qué haría

Qué cambia en cada `data/tracks/<id>.json`:
    "audio":         "assets/audio/tema.webm"   ← lo que suena
    "audioFallback": "assets/audio/tema.mp3"    ← para navegadores sin Opus

El mp3 NO se borra: sigue siendo el respaldo.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TRACKS = ROOT / "data" / "tracks"


def encode(src: Path, dst: Path) -> None:
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(src),
         "-c:a", "libopus", "-b:a", "64k", "-ac", "2", "-vn", str(dst)],
        check=True,
    )


def main() -> None:
    ap = argparse.ArgumentParser(description="Audio a Opus 64k + respaldo mp3.")
    ap.add_argument("--force", action="store_true", help="recodifica aunque exista")
    ap.add_argument("--dry-run", action="store_true", help="no escribe nada")
    args = ap.parse_args()

    if not subprocess.run(["ffmpeg", "-version"], capture_output=True).returncode == 0:
        sys.exit("Hace falta ffmpeg en el PATH.")

    total_old = total_new = 0
    rows = []
    for path in sorted(TRACKS.glob("*.json")):
        if path.name.startswith("_") or path.name.endswith(".overrides.json"):
            continue
        track = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(track, dict):
            continue
        audio = track.get("audio") or ""
        fallback = track.get("audioFallback") or ""
        if audio.lower().endswith(".webm"):
            webm_rel = audio
            mp3_rel = fallback or str(Path(audio).with_suffix(".mp3"))
        elif audio.lower().endswith(".mp3"):
            mp3_rel = audio
            webm_rel = str(Path(audio).with_suffix(".webm"))
        else:
            continue

        mp3 = ROOT / mp3_rel
        webm = ROOT / webm_rel
        if not mp3.exists():
            print(f"  ! falta {mp3_rel}, se omite", file=sys.stderr)
            continue

        needs = args.force or not webm.exists() or webm.stat().st_mtime < mp3.stat().st_mtime
        if needs and not args.dry_run:
            encode(mp3, webm)

        if webm.exists():
            old, new = mp3.stat().st_size, webm.stat().st_size
            total_old += old
            total_new += new
            rows.append((path.stem, old, new))

            if not args.dry_run:
                track["audio"] = webm_rel
                track["audioFallback"] = mp3_rel
                path.write_text(json.dumps(track, ensure_ascii=False, indent=2) + "\n",
                                encoding="utf-8")
        else:
            print(f"  · {path.stem}: sin .webm todavía", file=sys.stderr)

    print(f"\n  {'canción':<22} {'mp3':>9} {'opus 64k':>9}  ahorro")
    print("  " + "-" * 52)
    for name, old, new in rows:
        print(f"  {name:<22} {old/1048576:>7.1f} MB {new/1048576:>7.1f} MB "
              f"{100 * (1 - new / old):>6.0f} %")
    if total_old:
        print(f"  {'TOTAL':<22} {total_old/1048576:>7.1f} MB {total_new/1048576:>7.1f} MB "
              f"{100 * (1 - total_new / total_old):>6.0f} %")
    if args.dry_run:
        print("\n  --dry-run: no se escribió nada.")


if __name__ == "__main__":
    main()
