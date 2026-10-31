#!/usr/bin/env python3
"""
Apunta los audios de las canciones a un host externo (R2, CDN, bucket propio).

El repo no versiona las grabaciones de terceros, así que en el despliegue de
Vercel solo existe la pista de demostración. Con esto, cada `data/tracks/*.json`
pasa a llevar URLs absolutas:

    "audio":         "https://tu-host/cream.webm"
    "audioFallback": "https://tu-host/cream.mp3"

Uso:
    python3 tools/set_audio_host.py https://pub-xxxx.r2.dev
    python3 tools/set_audio_host.py https://pub-xxxx.r2.dev --dry-run
    python3 tools/set_audio_host.py --revert        # vuelve a rutas relativas

Después: commit y push. Vercel redespliega solo.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
TRACKS = ROOT / "data" / "tracks"


def tracks() -> list[Path]:
    out = []
    for path in sorted(TRACKS.glob("*.json")):
        if path.name.startswith("_") or path.name.endswith(".overrides.json"):
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and "lines" in data:
            out.append(path)
    return out


def rebase(value: str, base: str | None) -> str:
    """Reescribe una ruta de audio contra `base` (o la deja relativa)."""
    name = Path(urlparse(value).path).name
    if base is None:
        return f"assets/audio/{name}"
    return f"{base.rstrip('/')}/{name}"


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Apunta los audios a un host externo (o vuelve a rutas relativas).")
    ap.add_argument("base_url", nargs="?", help="p. ej. https://pub-xxxx.r2.dev")
    ap.add_argument("--revert", action="store_true", help="volver a assets/audio/…")
    ap.add_argument("--dry-run", action="store_true", help="mostrar sin escribir")
    args = ap.parse_args()

    if not args.revert:
        if not args.base_url:
            ap.error("falta la URL base (o usa --revert)")
        if not urlparse(args.base_url).scheme.startswith("http"):
            ap.error("la URL base debe empezar por http:// o https://")
    base = None if args.revert else args.base_url

    changed = 0
    for path in tracks():
        track = json.loads(path.read_text(encoding="utf-8"))
        before = (track.get("audio"), track.get("audioFallback"))

        track["audio"] = rebase(track.get("audio", ""), base)
        if track.get("audioFallback"):
            track["audioFallback"] = rebase(track["audioFallback"], base)

        after = (track["audio"], track["audioFallback"])
        print(f"  {path.stem:<20} {before[0]}")
        print(f"  {'':<20} → {after[0]}")
        if before != after:
            changed += 1
            if not args.dry_run:
                path.write_text(json.dumps(track, ensure_ascii=False, indent=2) + "\n",
                                encoding="utf-8")

    if args.dry_run:
        print(f"\n  --dry-run: {changed} fichero(s) cambiarían, no se escribió nada.")
    else:
        print(f"\n  {changed} fichero(s) actualizados.")
        print("  siguiente: git add -A && git commit -m 'audio: host externo' && git push")


if __name__ == "__main__":
    main()
