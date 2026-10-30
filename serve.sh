#!/usr/bin/env bash
# Arranca el servidor local del proyecto.
#   ./serve.sh            → http://localhost:8088
#   PORT=9000 ./serve.sh  → otro puerto
set -euo pipefail
cd "$(dirname "$0")"
exec python3 tools/server.py "${PORT:-8088}"
