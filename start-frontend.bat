@echo off
REM Starts the Vite dev server on http://localhost:5173
cd /d "%~dp0frontend"

if not exist node_modules (
  echo Installing frontend packages first...
  call npm install
)

echo Frontend starting - open http://localhost:5173
call npm run dev
