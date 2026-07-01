@echo off
rem KPIEE オンボーディング AI のサーバー(API:8787)とフロント(Vite:5173)を起動する。
rem 各プロセスは最小化ウィンドウで動き、ログは logs\ に出力される。
cd /d "%~dp0"
if not exist logs mkdir logs
start "kpiee-onboarding-server" /min cmd /c "cd /d ""%~dp0server"" && npm run dev > ""%~dp0logs\server.log"" 2>&1"
start "kpiee-onboarding-web" /min cmd /c "cd /d ""%~dp0web"" && npm run dev > ""%~dp0logs\web.log"" 2>&1"
