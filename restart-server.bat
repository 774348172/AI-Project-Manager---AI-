@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"

echo [白泽] 正在重启 BaizeLocalHub 服务...
echo [白泽] 项目目录：%cd%

net session >nul 2>&1
if errorlevel 1 (
  echo [白泽] 当前没有管理员权限，请右键以管理员身份运行此脚本。
  pause
  exit /b 1
)

tools\nssm.exe status BaizeLocalHub >nul 2>&1
if errorlevel 1 (
  echo [白泽] 未检测到 BaizeLocalHub 服务，无法重启。如果是首次部署，请先注册服务。
  pause
  exit /b 1
)

echo [白泽] 正在执行 nssm restart BaizeLocalHub...
tools\nssm.exe restart BaizeLocalHub
if errorlevel 1 (
  echo [白泽] 重启失败，请查看 logs\baize-server.log。
  pause
  exit /b 1
)

echo [白泽] 服务已重启，等待端口 3000 上线...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ok=$false; for ($i=0; $i -lt 15; $i++) { try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/health' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { $ok=$true; break } } catch {} ; Start-Sleep -Milliseconds 500 }; if ($ok) { Write-Host '[白泽] 健康检查通过：http://127.0.0.1:3000/health' } else { Write-Host '[白泽] 健康检查超时，请查看 logs\baize-server.log'; exit 1 }"

if errorlevel 1 (
  pause
  exit /b 1
)

echo [白泽] 完成。服务在后台运行，可关闭此窗口。
echo [白泽] 查看状态：tools\nssm.exe status BaizeLocalHub
echo [白泽] 查看日志：type logs\baize-server.log
pause
