@echo off
REM One-time setup for the backend on Windows.
REM Run this from the project root: setup.bat

echo === Creating virtual environment ===
cd backend
python -m venv .venv
if errorlevel 1 goto :error

echo === Installing Python packages ===
call .venv\Scripts\python.exe -m pip install --upgrade pip
call .venv\Scripts\python.exe -m pip install -r requirements.txt
if errorlevel 1 goto :error

if not exist .env (
  echo === Creating backend\.env ===
  copy .env.example .env >nul
  echo.
  echo   Created backend\.env - open it and paste your Anthropic API key
  echo   into ANTHROPIC_API_KEY before starting the server.
  echo.
)

echo === Adding sample tasks ===
call .venv\Scripts\python.exe seed.py

cd ..\frontend
echo === Installing frontend packages ===
call npm install
if errorlevel 1 goto :error

cd ..
echo.
echo ============================================
echo  Setup complete.
echo.
echo  1. Put your key in backend\.env
echo  2. Run start-backend.bat   (keep it open)
echo  3. Run start-frontend.bat  (in a new window)
echo  4. Open http://localhost:5173
echo ============================================
goto :eof

:error
echo.
echo Setup failed. See the messages above.
exit /b 1
