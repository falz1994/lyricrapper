#!/usr/bin/env python3
"""
Servidor local del proyecto (y opcionalmente, "modo estudio").

    python3 tools/server.py            # http://localhost:8088
    python3 tools/server.py 9000

Además de servir los archivos estáticos, expone dos endpoints que usa el
estudio de sincronización para no tener que mover archivos a mano:

    PUT  /api/upload?name=cancion.mp3   → guarda el audio en assets/audio/
    POST /api/track                     → guarda el JSON en data/tracks/ y lo
                                          agrega a data/tracks.json

El sitio sigue siendo 100 % estático: si abres index.html con cualquier otro
servidor, los botones de guardado muestran el archivo para descargar.

Ojo: no hay autenticación. Pensado para localhost, no para exponerlo.
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
AUDIO_DIR = ROOT / "assets" / "audio"
TRACKS_DIR = ROOT / "data" / "tracks"
INDEX = ROOT / "data" / "tracks.json"
ANALYTICS = ROOT / "data" / "analytics.jsonl"   # eventos de assets/js/analytics.js

SAFE_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,60}$")
SAFE_AUDIO = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._-]{0,90}\.(mp3|m4a|ogg|opus|wav|flac)$", re.I)
MAX_UPLOAD = 60 * 1024 * 1024          # 60 MB
MAX_JSON = 4 * 1024 * 1024


class _Slice:
    """Archivo recortado a un rango de bytes, para respuestas 206."""

    def __init__(self, fh, remaining: int):
        self.fh = fh
        self.remaining = remaining

    def read(self, n: int = -1) -> bytes:
        if self.remaining <= 0:
            return b""
        if n is None or n < 0 or n > self.remaining:
            n = self.remaining
        chunk = self.fh.read(n)
        self.remaining -= len(chunk)
        return chunk

    def close(self) -> None:
        self.fh.close()


class Handler(SimpleHTTPRequestHandler):
    # Los .webm del proyecto son audio (Opus), no vídeo: mimetypes los sirve
    # como video/webm y algunos navegadores se plantan al alimentar un <audio>.
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".webm": "audio/webm",
        ".opus": "audio/ogg",
        ".m4a": "audio/mp4",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    # --- utilidades ------------------------------------------------------
    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _no_content(self) -> None:
        """204 sin cuerpo (lo que espera sendBeacon)."""
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def _body(self, limit: int) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > limit:
            raise ValueError("tamaño inválido")
        return self.rfile.read(length)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        # Sin esto Chrome descarga el MP3 completo antes de permitir saltos.
        if getattr(self, "_accept_ranges", False):
            self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            sys.stderr.write("  api %s\n" % (args[0] if args else ""))

    # --- peticiones parciales (audio) ------------------------------------
    def send_head(self):
        """Soporte de `Range`: imprescindible para que el <audio> pueda saltar."""
        header = self.headers.get("Range")
        if not header:
            return super().send_head()

        match = re.fullmatch(r"bytes=(\d*)-(\d*)", header.strip())
        if not match or (not match.group(1) and not match.group(2)):
            return super().send_head()

        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()
        try:
            fh = open(path, "rb")
        except OSError:
            return super().send_head()

        size = os.fstat(fh.fileno()).st_size
        first, last = match.group(1), match.group(2)
        if first:
            start = int(first)
            end = min(int(last), size - 1) if last else size - 1
        else:                                   # bytes=-N  → últimos N bytes
            start = max(0, size - int(last))
            end = size - 1

        if start >= size or start > end:
            fh.close()
            self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None

        fh.seek(start)
        self._accept_ranges = True
        self.send_response(HTTPStatus.PARTIAL_CONTENT)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Last-Modified", self.date_time_string(os.fstat(fh.fileno()).st_mtime))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        return _Slice(fh, end - start + 1)

    # --- rutas -----------------------------------------------------------
    def do_OPTIONS(self):                     # noqa: N802
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self):                         # noqa: N802
        path = urlparse(self.path).path
        if path == "/api/ping":
            return self._json(200, {"ok": True, "studio": True})
        if path == "/api/stats":
            return self._json(200, self._stats())
        self._accept_ranges = True
        return super().do_GET()

    # --- analítica local --------------------------------------------------
    def _log_event(self) -> None:
        """POST /api/event: guarda una línea JSON en data/analytics.jsonl."""
        try:
            payload = json.loads(self._body(8 * 1024))
        except ValueError:
            return self._json(400, {"ok": False, "error": "cuerpo inválido"})

        if not isinstance(payload, dict) or not payload.get("event"):
            return self._json(400, {"ok": False, "error": "falta event"})

        entry = {
            "t": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "event": str(payload.get("event"))[:40],
            "sid": str(payload.get("sid") or "")[:64],
            "path": str(payload.get("path") or "")[:200],
            "track": str(payload.get("track") or "")[:60] or None,
            "line": payload.get("line") if isinstance(payload.get("line"), int) else None,
            "ref": str(payload.get("ref") or "")[:300] or None,
        }
        ANALYTICS.parent.mkdir(parents=True, exist_ok=True)
        with ANALYTICS.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
        return self._no_content()

    def _stats(self) -> dict:
        """GET /api/stats: resumen de data/analytics.jsonl."""
        if not ANALYTICS.exists():
            return {"ok": True, "total": 0, "events": {}, "sessions": 0,
                    "tracks": {}, "lines": {}, "days": {}}

        events: dict[str, int] = {}
        sessions: set[str] = set()
        tracks: dict[str, int] = {}
        lines: dict[str, int] = {}
        days: dict[str, int] = {}
        total = 0
        for raw in ANALYTICS.read_text(encoding="utf-8").splitlines():
            try:
                e = json.loads(raw)
            except ValueError:
                continue
            total += 1
            events[e.get("event", "?")] = events.get(e.get("event", "?"), 0) + 1
            if e.get("sid"):
                sessions.add(e["sid"])
            if e.get("track"):
                tracks[e["track"]] = tracks.get(e["track"], 0) + 1
            if e.get("track") and e.get("line"):
                key = f"{e['track']}:{e['line']}"
                lines[key] = lines.get(key, 0) + 1
            day = str(e.get("t", ""))[:10]
            if day:
                days[day] = days.get(day, 0) + 1

        return {
            "ok": True,
            "total": total,
            "sessions": len(sessions),
            "events": dict(sorted(events.items(), key=lambda kv: -kv[1])),
            "tracks": dict(sorted(tracks.items(), key=lambda kv: -kv[1])),
            "lines": dict(sorted(lines.items(), key=lambda kv: -kv[1])[:50]),
            "days": dict(sorted(days.items())),
        }

    def do_PUT(self):                         # noqa: N802
        url = urlparse(self.path)
        if url.path != "/api/upload":
            return self._json(404, {"ok": False, "error": "ruta desconocida"})

        name = (parse_qs(url.query).get("name") or [""])[0]
        if not SAFE_AUDIO.match(name):
            return self._json(400, {"ok": False, "error": "nombre de archivo no permitido"})

        try:
            data = self._body(MAX_UPLOAD)
        except ValueError as exc:
            return self._json(400, {"ok": False, "error": str(exc)})

        AUDIO_DIR.mkdir(parents=True, exist_ok=True)
        dest = AUDIO_DIR / name
        dest.write_bytes(data)
        return self._json(200, {
            "ok": True,
            "path": f"assets/audio/{name}",
            "bytes": len(data),
        })

    def do_POST(self):                        # noqa: N802
        path = urlparse(self.path).path
        if path == "/api/event":
            return self._log_event()
        if path != "/api/track":
            return self._json(404, {"ok": False, "error": "ruta desconocida"})

        try:
            track = json.loads(self._body(MAX_JSON))
        except ValueError as exc:
            return self._json(400, {"ok": False, "error": str(exc)})

        track_id = str(track.get("id") or "").strip()
        if not SAFE_ID.match(track_id):
            return self._json(400, {"ok": False, "error": "id inválido (a-z, 0-9, -, _)"})
        if not isinstance(track.get("lines"), list) or not track["lines"]:
            return self._json(400, {"ok": False, "error": "el track no tiene líneas"})

        TRACKS_DIR.mkdir(parents=True, exist_ok=True)
        dest = TRACKS_DIR / f"{track_id}.json"
        dest.write_text(json.dumps(track, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        # actualizar el índice sin duplicar
        try:
            index = json.loads(INDEX.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            index = {"tracks": []}
        entry = {
            "id": track_id,
            "title": track.get("title") or track_id,
            "artist": track.get("artist") or "",
            "file": f"data/tracks/{track_id}.json",
        }
        tracks = [t for t in index.get("tracks", []) if t.get("id") != track_id]
        tracks.append(entry)
        index["tracks"] = tracks
        INDEX.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        return self._json(200, {
            "ok": True,
            "file": entry["file"],
            "track": entry,
            "url": f"/?track={track_id}",
        })


def _lan_ips() -> list[str]:
    """IPv4 de la red local, para imprimir la URL que abrir desde el móvil."""
    out: list[str] = []
    try:
        import socket
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("192.168.0.1", 1))       # no envía nada: sólo elige interfaz
            out.append(s.getsockname()[0])
        finally:
            s.close()
    except OSError:
        pass
    return [ip for ip in out if not ip.startswith("127.")]


def main() -> None:
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8088
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"\n  Lyric Rapper → http://localhost:{port}")
    if host in ("0.0.0.0", "::", ""):
        for ip in _lan_ips():
            print(f"  desde el móvil (misma Wi-Fi) → http://{ip}:{port}")
        print("  aviso: cualquiera en tu red puede entrar mientras esté abierto")
    else:
        print("  sólo local; para abrirlo al móvil:  HOST=0.0.0.0 ./serve.sh")
    print(f"  raíz: {ROOT}")
    print("  Ctrl+C para detener\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  adiós\n")


if __name__ == "__main__":
    main()
