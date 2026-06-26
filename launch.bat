@echo off
setlocal

:: PortOS Desktop Launcher
:: Starts PortOS natively on Windows — no Docker, no Unraid

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

echo.
echo  PortOS Launcher
echo  ─────────────────────────────────────────
echo.

:: ── Node.js ───────────────────────────────────────────────────────────────────
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found.
  echo         Download from https://nodejs.org/ and re-run this launcher.
  pause
  exit /b 1
)
for /f "tokens=*" %%V in ('node --version 2^>^&1') do set "NODE_VER=%%V"
echo [OK] Node.js %NODE_VER%

:: ── Git Bash (required by db.sh database setup scripts) ──────────────────────
set "BASH_EXE="
if exist "C:\Program Files\Git\bin\bash.exe" set "BASH_EXE=C:\Program Files\Git\bin\bash.exe"
if not defined BASH_EXE (
  if exist "%LOCALAPPDATA%\Programs\Git\bin\bash.exe" (
    set "BASH_EXE=%LOCALAPPDATA%\Programs\Git\bin\bash.exe"
  )
)
if defined BASH_EXE (
  echo [OK] Git Bash found
) else (
  echo [WARN] Git Bash not found -- install from https://git-scm.com/download/win
  echo        Database setup scripts require it.
)

:: ── PostgreSQL (add to PATH if installer didn't) ──────────────────────────────
where psql >nul 2>&1
if errorlevel 1 (
  for %%V in (17 16 15 14) do (
    if exist "C:\Program Files\PostgreSQL\%%V\bin\psql.exe" (
      set "PATH=C:\Program Files\PostgreSQL\%%V\bin;%PATH%"
      echo [OK] PostgreSQL %%V added to PATH
      goto :pg_done
    )
  )
  echo [WARN] PostgreSQL not found -- install from https://www.postgresql.org/download/windows/
  echo        After installing, re-run this launcher.
) else (
  echo [OK] PostgreSQL found
)
:pg_done

:: ── Tailscale HTTPS (optional -- uncomment to enable) ────────────────────────
:: where tailscale >nul 2>&1
:: if not errorlevel 1 (
::   echo [TAILSCALE] Enabling Tailscale HTTPS proxy on port 5555...
::   tailscale serve --bg --https=443 http://127.0.0.1:5555
:: )

:: ── First run: install all dependencies and set up the database ───────────────
if not exist "%ROOT%\node_modules\pm2" (
  echo.
  echo [SETUP] First run detected -- installing dependencies...
  echo         This may take a few minutes.
  echo.
  cd /d "%ROOT%"
  call npm run setup
  if errorlevel 1 (
    echo.
    echo [ERROR] Setup failed. Review the output above for details.
    pause
    exit /b 1
  )
)

:: ── Start PortOS ──────────────────────────────────────────────────────────────
echo.
echo [START] Starting PortOS...
echo         Dashboard: http://localhost:5555
echo.
cd /d "%ROOT%"
call npm start

pause
endlocal
