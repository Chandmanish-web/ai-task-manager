#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  Run the WHOLE app as one thing, on one port.
#
#  Builds the React frontend, then starts the backend, which serves that build
#  itself. One terminal, one URL: http://127.0.0.1:8000
#
#  Use this when you just want to USE the app. For frontend development, run
#  the backend and `npm run dev` separately — the Vite dev server on :5173
#  gives you instant hot reload, which this mode does not.
# ---------------------------------------------------------------------------
set -e
cd "$(dirname "$0")"

if [ ! -x backend/.venv/bin/python ]; then
  echo ""
  echo "  Virtual environment not found. Run: bash setup.sh"
  echo ""
  exit 1
fi

if [ ! -f backend/.env ]; then
  cp backend/.env.example backend/.env
  echo ""
  echo "  Created backend/.env — paste your Anthropic API key into it,"
  echo "  then run this again."
  echo ""
  exit 1
fi

echo "=== Building the frontend ==="
cd frontend
[ -d node_modules ] || npm install
npm run build

cd ../backend
cat <<'EOF'

============================================
 App running at http://127.0.0.1:8000
 API docs at   http://127.0.0.1:8000/docs

 Press Ctrl+C to stop.
============================================

EOF
exec ./.venv/bin/python -m uvicorn app.main:app --port 8000
