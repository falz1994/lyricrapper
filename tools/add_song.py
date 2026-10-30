#!/usr/bin/env python3
"""
Agrega una canción al proyecto en un solo paso.

    python3 tools/add_song.py mi-audio.mp3 letra.txt \
        --title "N.Y. State of Mind" --artist "Nas"

Qué hace:
  1. Copia el audio a assets/audio/ (con un nombre seguro).
  2. Alinea la letra contra el audio con Whisper (tools/align.py).
  3. Escribe data/tracks/<id>.json y lo agrega a data/tracks.json.
  4. Te dice la URL para abrirla en el reproductor.

Si prefieres marcar los tiempos a oído, usa --no-align: deja un borrador con las
líneas repartidas a lo largo del audio y las ajustas en sync.html.

Para fuentes más flexibles (una URL a un archivo de audio, la letra sacada del
propio audio) usa tools/sync_tool.py.

El audio tiene que ser tuyo (tu CD, tu compra). Este script no descarga nada.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import songkit as kit  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description="Agrega una canción al proyecto (audio + letra → JSON).")
    ap.add_argument("audio", type=Path, help="tu archivo de audio")
    ap.add_argument("lyrics", type=Path, help="texto plano, una línea por renglón")
    ap.add_argument("--id")
    ap.add_argument("--title")
    ap.add_argument("--artist", default="")
    ap.add_argument("--album", default="")
    ap.add_argument("--language", default=None, help="es, en… (vacío = autodetectar)")
    ap.add_argument("--model", default="base", help="tiny | base | small | medium")
    ap.add_argument("--offset", type=float, default=0.0, help="desplazamiento global en segundos")
    ap.add_argument("--no-align", action="store_true",
                    help="no usar Whisper: deja un borrador repartido y se ajusta en sync.html")
    args = ap.parse_args()

    if not args.audio.exists():
        sys.exit(f"No existe el audio: {args.audio}")
    if not args.lyrics.exists():
        sys.exit(f"No existe la letra: {args.lyrics}")

    lines = kit.read_lines(args.lyrics)
    if not lines:
        sys.exit("La letra está vacía (¿una línea por renglón?).")

    title = args.title or args.audio.stem
    track_id = args.id or kit.slug(title)

    dest_audio, audio_rel = kit.copy_audio(args.audio)
    if dest_audio.resolve() != args.audio.resolve():
        print(f"· audio copiado a {audio_rel}", file=sys.stderr)
    duration = kit.duration_of(dest_audio)

    out_json = kit.TRACKS_DIR / f"{track_id}.json"

    use_align = not args.no_align
    if use_align and not kit.has_whisper():
        print("· no encontré faster-whisper: dejo un borrador (instálalo con "
              "pip install --target tools/pylib -r tools/requirements.txt)", file=sys.stderr)
        use_align = False

    if use_align:
        print(f"· alineando con Whisper ({args.model})… puede tardar varios minutos", file=sys.stderr)
        code = kit.align_with_whisper(
            dest_audio, args.lyrics, out_json,
            track_id=track_id, title=title, artist=args.artist, album=args.album,
            model=args.model, language=args.language, offset=args.offset,
        )
        if code != 0:
            sys.exit("La alineación falló. Prueba --no-align y marca los tiempos en sync.html.")
        track = json.loads(out_json.read_text(encoding="utf-8"))
        track["album"] = args.album
        kit.write_track(track, out_json)
    else:
        track = kit.draft_track(audio_rel, lines, duration, track_id, title, args.artist, args.album)
        kit.write_track(track, out_json)
        print(f"· borrador escrito en {out_json.relative_to(kit.ROOT)}", file=sys.stderr)

    kit.update_index({
        "id": track_id,
        "title": title,
        "artist": args.artist,
        "file": f"data/tracks/{track_id}.json",
    })

    print()
    print(f"  listo: {len(track.get('lines', []))} líneas · {duration:.1f} s · {audio_rel}")
    print(f"  reproductor → http://localhost:8088/?track={track_id}")
    print(f"  ajustar     → http://localhost:8088/sync.html   "
          f"(Importar JSON: {out_json.relative_to(kit.ROOT)})")
    print()


if __name__ == "__main__":
    main()
