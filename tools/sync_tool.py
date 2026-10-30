#!/usr/bin/env python3
"""
La herramienta automática: fuente → audio → letra → timestamps, en un comando.

    # 1) un archivo que ya tienes, con la letra en texto
    python3 tools/sync_tool.py ~/música/mi-tema.mp3 --lyrics letra.txt \
        --title "Mi tema" --artist "Yo"

    # 2) un archivo, y que la letra la saque transcribiendo el audio
    python3 tools/sync_tool.py ~/música/mi-tema.mp3 --auto-lyrics \
        --title "Mi tema" --artist "Yo"

    # 3) una URL a un archivo de audio (tu hosting, una fuente con licencia)
    python3 tools/sync_tool.py https://mi-sitio.com/tema.mp3 --auto-lyrics

Qué hace, en orden:
  1. Resuelve la fuente: copia el archivo o lo descarga si es una URL directa.
  2. Consigue la letra: la lee de un .txt/.lrc, la saca transcribiendo el audio
     (--auto-lyrics) o reparte las líneas en un borrador.
  3. Alinea y escribe data/tracks/<id>.json + lo agrega a data/tracks.json.
  4. Imprime la URL del reproductor y del estudio.

Qué NO hace, a propósito:
  · No descarga audio de YouTube (ni de ningún sitio que no sirva el archivo
    como archivo). Si el enlace es de YouTube, se detiene y te lo dice.
  · No busca letras en sitios de letras. O las tienes tú, o las saca del audio.

Usa el audio que tengas derecho a usar: el tuyo, el que compraste, o uno con
licencia abierta.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import songkit as kit  # noqa: E402


YOUTUBE_HELP = """\
✗ No descargo audio de YouTube.

  El enlace es de YouTube: {title}
  canal: {channel}

  Bajar el audio de ahí infringe derechos de autor y los términos del servicio,
  y eso no depende de tener más o menos permisos en la nube.

  Lo que sí puedo hacer:

    · si el tema es tuyo o lo tienes comprado, pásame el archivo:
        python3 tools/sync_tool.py ~/música/mi-tema.mp3 --lyrics letra.txt

    · si es una grabación tuya y no tienes la letra escrita, la saco del audio:
        python3 tools/sync_tool.py ~/música/mi-tema.mp3 --auto-lyrics

    · si el audio está servido como archivo (tu hosting, licencia abierta):
        python3 tools/sync_tool.py https://mi-sitio.com/tema.mp3 --auto-lyrics
"""


def resolve_source(source: str) -> Path:
    """Devuelve la ruta local del audio, copiándolo o descargándolo si hace falta."""
    if source.startswith(("http://", "https://")):
        video = kit.youtube_id(source)
        if video:
            meta = kit.youtube_meta(video)
            print(YOUTUBE_HELP.format(
                title=meta.get("title") or f"vídeo {video}",
                channel=meta.get("author_name") or "desconocido",
            ), file=sys.stderr)
            sys.exit(2)

        try:
            return kit.download_audio(source)
        except ValueError as exc:
            sys.exit(f"No puedo usar esa URL: {exc}")

    path = Path(source).expanduser()
    if not path.exists():
        sys.exit(f"No existe: {path}")
    if path.suffix.lower() not in kit.AUDIO_EXT:
        sys.exit(f"Extensión no reconocida ({path.suffix}). "
                 f"Se aceptan: {', '.join(sorted(kit.AUDIO_EXT))}")
    return path


def guess_lyrics_file(audio: Path) -> Path | None:
    """Busca un .txt/.lrc con el mismo nombre, al lado del audio o en la raíz."""
    for folder in (audio.parent, kit.ROOT):
        for suffix in (".txt", ".lrc"):
            candidate = folder / f"{audio.stem}{suffix}"
            if candidate.exists():
                return candidate
    return None


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Fuente → audio + letra → canción sincronizada, en un comando.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    ap.add_argument("source", help="archivo de audio o URL directa a un archivo de audio")
    ap.add_argument("--lyrics", type=Path, help="texto plano, una línea por renglón")
    ap.add_argument("--auto-lyrics", action="store_true",
                    help="sacar la letra transcribiendo el audio (sin buscar en internet)")
    ap.add_argument("--id")
    ap.add_argument("--title")
    ap.add_argument("--artist", default="")
    ap.add_argument("--album", default="")
    ap.add_argument("--language", default=None, help="es, en… (vacío = autodetectar)")
    ap.add_argument("--model", default="base", help="tiny | base | small | medium")
    ap.add_argument("--offset", type=float, default=0.0, help="desplazamiento global en segundos")
    ap.add_argument("--no-align", action="store_true",
                    help="no alinear: reparte las líneas como borrador")
    args = ap.parse_args()

    # 1) fuente
    audio_src = resolve_source(args.source)
    dest_audio, audio_rel = kit.copy_audio(audio_src)
    if dest_audio.resolve() != audio_src.resolve():
        print(f"· audio copiado a {audio_rel}", file=sys.stderr)
    duration = kit.duration_of(dest_audio)
    if not duration:
        print("· aviso: no pude leer la duración (¿ffprobe instalado?)", file=sys.stderr)

    title = args.title or audio_src.stem
    track_id = args.id or kit.slug(title)
    out_json = kit.TRACKS_DIR / f"{track_id}.json"

    # 2) letra
    if args.lyrics and args.auto_lyrics:
        sys.exit("Elige una: --lyrics (tu texto) o --auto-lyrics (transcribir), no las dos.")

    lyrics_path = args.lyrics
    if not lyrics_path and not args.auto_lyrics:
        found = guess_lyrics_file(audio_src)
        if found:
            lyrics_path = found
            print(f"· encontré la letra al lado del audio: {found.name}", file=sys.stderr)

    if args.auto_lyrics:
        if not kit.has_whisper():
            sys.exit("Falta faster-whisper: pip install --target tools/pylib -r tools/requirements.txt")
        lines, duration = kit.transcribe_lines(dest_audio, model=args.model, language=args.language)
        if not lines:
            sys.exit(
                "No detecté voz en el audio.\n"
                "  Si es instrumental o el beat tapa la voz, pásale la letra a mano:\n"
                "    --lyrics letra.txt"
            )
        track = {
            "id": track_id,
            "title": title,
            "artist": args.artist,
            "album": args.album,
            "kicker": f"Letra transcrita y sincronizada ({args.model})",
            "audio": audio_rel,
            "duration": duration,
            "bpm": None,
            "language": args.language or "",
            "lines": [
                {"start": round(max(0.0, ln["start"] + args.offset), 3),
                 "end": round(max(0.0, ln["end"] + args.offset), 3),
                 "text": ln["text"]}
                for ln in lines
            ],
        }
        kit.write_track(track, out_json)
        print(f"· escrito {out_json.relative_to(kit.ROOT)}", file=sys.stderr)

    elif lyrics_path:
        text_lines = kit.read_lines(lyrics_path)
        if not text_lines:
            sys.exit(f"La letra está vacía: {lyrics_path}")

        if args.no_align or not kit.has_whisper():
            track = kit.draft_track(audio_rel, text_lines, duration, track_id,
                                    title, args.artist, args.album)
            kit.write_track(track, out_json)
            print("· borrador sin alinear (usa el estudio para ajustar)", file=sys.stderr)
        else:
            print(f"· alineando con Whisper ({args.model})… puede tardar varios minutos", file=sys.stderr)
            code = kit.align_with_whisper(
                dest_audio, lyrics_path, out_json,
                track_id=track_id, title=title, artist=args.artist, album=args.album,
                model=args.model, language=args.language, offset=args.offset,
            )
            if code != 0:
                sys.exit("La alineación falló. Prueba --no-align y marca los tiempos en sync.html.")
            track = json.loads(out_json.read_text(encoding="utf-8"))
            track["album"] = args.album
            kit.write_track(track, out_json)

    else:
        sys.exit(
            "No hay letra. Dame una de estas dos cosas:\n"
            "  --lyrics letra.txt   (tu texto, una línea por renglón)\n"
            "  --auto-lyrics        (la saco transcribiendo el audio)"
        )

    # 3) índice
    kit.update_index({
        "id": track_id,
        "title": title,
        "artist": args.artist,
        "file": f"data/tracks/{track_id}.json",
    })

    n = len(track.get("lines", []))
    print()
    print(f"  listo: {n} líneas · {duration:.1f} s · {audio_rel}")
    print(f"  reproductor → http://localhost:8088/?track={track_id}")
    print(f"  ajustar     → http://localhost:8088/sync.html   "
          f"(Importar JSON: {out_json.relative_to(kit.ROOT)})")
    print()


if __name__ == "__main__":
    main()
