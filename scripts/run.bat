@echo off
REM BigHead 一键启动:后端 (FastAPI) + 前端 (Vite dev)
REM 复用 webui 的 .venv
REM
REM 先设 BIGHEAD_WEBUI_PYTHON 指向你本机 webui 的 venv 解释器,例如:
REM   set BIGHEAD_WEBUI_PYTHON=D:\path\to\stable-diffusion-webui\.venv\Scripts\python.exe
REM 不设就直接跑会明确报错退出,而不是拿一个假路径去启动。

if "%BIGHEAD_WEBUI_PYTHON%"=="" (
  echo 请先设置 BIGHEAD_WEBUI_PYTHON 指向 Stable Diffusion WebUI 的 venv 解释器,例如:
  echo   set BIGHEAD_WEBUI_PYTHON=D:\path\to\stable-diffusion-webui\.venv\Scripts\python.exe
  exit /b 1
)

set VENV=%BIGHEAD_WEBUI_PYTHON%

if not exist "%VENV%" (
  echo 找不到解释器: %VENV%
  exit /b 1
)

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
