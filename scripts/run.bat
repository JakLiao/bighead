@echo off
REM BigHead 一键启动:后端 (FastAPI) + 前端 (Vite dev)
REM 复用 webui 的 .venv

set VENV=E:\Code\stable-diffusion-webui\.venv\Scripts\python.exe

REM 后端:uvicorn 8000
start "BigHead-Backend" cmd /k "cd /d %~dp0\.. && %VENV% -m uvicorn backend.app:app --host 0.0.0.0 --port 8000 --reload"

REM 前端:vite dev 5173
start "BigHead-Frontend" cmd /k "cd /d %~dp0\..\frontend && if not exist node_modules (npm install) && npm run dev"

echo.
echo ==========================================
echo  BigHead started
echo   Backend  http://localhost:8000
echo   Frontend http://localhost:5173
echo ==========================================
echo (两个终端窗口已打开,关闭它们即停止服务)
pause
