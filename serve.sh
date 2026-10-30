#!/usr/bin/env bash
# Arranca el servidor local del proyecto.
#   ./serve.sh                  → http://localhost:8088 (sólo este equipo)
#   PORT=9000 ./serve.sh        → otro puerto
#   HOST=0.0.0.0 ./serve.sh     → accesible desde el móvil en la misma Wi-Fi
set -euo pipefail
cd "$(dirname "$0")"
exec python3 tools/server.py "${PORT:-8088}"
