@echo off
setlocal

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-windows.ps1"
if errorlevel 1 (
    echo.
    echo [ERROR] Windows 打包失败。
    pause
    exit /b 1
)

echo.
echo [OK] Windows 安装包已生成到 release 目录。
pause
