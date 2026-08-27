@echo off
REM ---------------------------------------------------------------------------
REM  Run the WHOLE app as one thing, on one port.
REM
REM  Builds the React frontend, then starts the backend, which serves that
REM  build itself. One window, one URL: http://127.0.0.1:8000
REM
REM  Use this when you just want to USE the app. For frontend development, run
REM  start-backend.bat and start-frontend.bat instead - the Vite dev server on
REM  :5173 gives you instant hot reload, which this mode does not.
REM ---------------------------------------------------------------------------
cd /d "%~dp0"

if not exist backend\.venv\Scripts\python.exe (
  echo.
  echo   Virtual environment not found. Run setup.bat first.
  echo.
  pause
  exit /b 1
)

if not exist backend\.env (
  echo.
  echo   No backend\.env found. Creating one from the example...
  copy backend\.env.example backend\.env >nul
  echo   Open backend\.env, paste your Anthropic API key, then run this again.
  echo.
  pause
  exit /b 1
)

echo === Building the frontend ===
cd frontend
if not exist node_modules (
  echo Installing frontend packages first...
  call npm install
  if errorlevel 1 goto :buildfail
)
call npm run build
if errorlevel 1 goto :buildfail

cd ..\backend
echo.
echo ============================================
echo  App running at http://127.0.0.1:8000
echo  API docs at   http://127.0.0.1:8000/docs
echo.
echo  Press Ctrl+C to stop.
echo ============================================
echo.
.venv\Scripts\python.exe -m uvicorn app.main:app --port 8000
goto :eof

:buildfail
echo.
echo   Frontend build failed. See the messages above.
echo   You can still run the app in two-window mode:
echo     start-backend.bat  then  start-frontend.bat
echo.
pause
exit /b 1
