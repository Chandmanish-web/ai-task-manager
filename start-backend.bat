@echo off
REM Starts the FastAPI backend on http://127.0.0.1:8000
cd /d "%~dp0backend"

if not exist .venv\Scripts\python.exe (
  echo Virtual environment not found. Run setup.bat first.
  pause
  exit /b 1
)

if not exist .env (
  echo.
  echo   No backend\.env found. Creating one from the example...
  copy .env.example .env >nul
  echo   Open backend\.env and paste your Anthropic API key, then rerun this.
  echo.
)

echo Backend starting - API docs at http://127.0.0.1:8000/docs
.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000
