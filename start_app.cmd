@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
set "PORT="

for /L %%P in (5050,1,5060) do (
  powershell -NoProfile -Command "$client = New-Object Net.Sockets.TcpClient; try { $client.Connect('127.0.0.1', %%P); $client.Close(); exit 1 } catch { exit 0 }" > nul 2> nul
  if not errorlevel 1 (
    set "PORT=%%P"
    goto found_port
  )
)

echo 5050-5060 사이에서 빈 포트를 찾지 못했습니다.
pause
exit /b 1

:found_port
echo Server: http://127.0.0.1:%PORT%/
start "Stock Scanner Server" cmd /k "cd /d ""%~dp0"" && set PORT=%PORT% && title Stock Scanner Server :%PORT% && echo Server: http://127.0.0.1:%PORT%/ && echo Keep this window open while using the app. && node server.mjs"
ping 127.0.0.1 -n 4 > nul
start "" http://127.0.0.1:%PORT%/
