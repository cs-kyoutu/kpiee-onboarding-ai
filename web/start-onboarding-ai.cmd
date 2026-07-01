@echo off
chcp 65001 >nul
rem KPIEE オンボーディング自動化 AI - ワンクリック起動
rem  - API サーバー (Express :8787) と フロント (Vite :5173) を別ウィンドウで起動し、
rem    ブラウザで http://localhost:5173 を開く。

set "ROOT=%~dp0.."

echo [1/3] API サーバーを起動します (port 8787)...
start "kpiee-onboarding API (:8787)" cmd /k "cd /d "%ROOT%\server" && npm run dev"

echo [2/3] フロントエンドを起動します (port 5173)...
start "kpiee-onboarding WEB (:5173)" cmd /k "cd /d "%ROOT%\web" && npm run dev"

echo [3/3] ブラウザが開くまで待機します...
timeout /t 6 /nobreak >nul
start "" "http://localhost:5173"

echo.
echo  起動しました。ブラウザ: http://localhost:5173
echo  停止するには起動した2つのウィンドウを閉じてください。
echo.
pause
