#!/usr/bin/env bash
# One-time setup for macOS / Linux. Run from the project root: bash setup.sh
set -e

echo "=== Creating virtual environment ==="
cd backend
python3 -m venv .venv
./.venv/bin/python -m pip install --upgrade pip --quiet

echo "=== Installing Python packages ==="
./.venv/bin/python -m pip install -r requirements.txt

if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "  Created backend/.env — paste your Anthropic API key into"
  echo "  ANTHROPIC_API_KEY before starting the server."
  echo ""
fi

echo "=== Adding sample tasks ==="
./.venv/bin/python seed.py

cd ../frontend
echo "=== Installing frontend packages ==="
npm install

cd ..
cat <<'EOF'

============================================
 Setup complete.

 1. Put your key in backend/.env
 2. cd backend  && ./.venv/bin/python -m uvicorn app.main:app --reload
 3. cd frontend && npm run dev      (second terminal)
 4. Open http://localhost:5173
============================================
EOF
