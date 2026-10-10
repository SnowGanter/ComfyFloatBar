@echo off
echo ============================================================
echo   ComfyFloatBar Builder (v1.5) -- win-unpacked folder
echo ============================================================
echo.

:: Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Install from https://nodejs.org/
    pause
    exit /b 1
)

:: Check if we're in the right directory
if not exist "main.js" (
    echo [ERROR] Run this script from the comfy-float-bar folder!
    echo          The folder must contain main.js, index.html, etc.
    pause
    exit /b 1
)

echo [1/3] Installing main app dependencies...
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] npm install failed!
    pause
    exit /b 1
)

echo [2/3] Installing hub-service dependencies...
pushd mini-services\hub-service
call npm install
popd

echo [3/3] Building win-unpacked folder (for distribution)...
call npx electron-builder --win dir
if %errorlevel% neq 0 (
    echo [ERROR] Build failed!
    pause
    exit /b 1
)

echo.
echo ============================================================
echo   BUILD COMPLETE!
echo ============================================================
echo.
echo   Output: dist\win-unpacked\
echo.
echo   Rename dist\win-unpacked to ComfyFloatBar before distributing!
echo   Colleagues run ComfyFloatBar.exe inside it.
echo.
echo   Folder structure (inside the distribution folder):
echo     ComfyFloatBar\  -- settings (nickname, sliders, hotkeys, IPs)
echo     download\       -- output files (Generations, Upscales, etc.)
echo.
echo   Setup wizard: enter nickname (required) then done!
echo ============================================================
pause
