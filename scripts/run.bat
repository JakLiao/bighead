@echo off
REM BigHead 一键启动:后端 (FastAPI) + 前端 (Vite dev)
REM 复用 webui 的 .venv

set VENV=E:\Code\stable-diffusion-webui\.venv\Scripts\python.exe

REM 后端:uvicorn 8077(不用通用 8000,本机常被占用)
start "BigHead-Backend" cmd /k "cd /d %~dp0\.. && %VENV% -m uvicorn backend.app:app --host 127.0.0.1 --port 8077 --reload"

REM 前端需显式指向 8077,否则 vite 会代理到默认 8000
set BIGHEAD_API_TARGET=http://127.0.0.1:8077

REM 前端:vite dev 5173
start "BigHead-Frontend" cmd /k "cd /d %~dp0\..\frontend && if not exist node_modules (npm install) && npm run dev"

echo.
echo ==========================================
echo  BigHead started
echo   Backend  http://localhost:8077
echo   Frontend http://localhost:5173
echo ==========================================
echo (两个终端窗口已打开,关闭它们即停止服务)
pause
