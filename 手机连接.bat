@echo off
chcp 65001 >nul
title 手机连接配置 - 苏格拉底阅读器
echo ==================================================
echo  把阅读器开放给同一 WiFi 下的手机访问
echo  需要管理员权限（会转发 3777 端口 + 放行防火墙）
echo ==================================================
echo.

REM 取 WSL 的 IP
for /f "usebackq tokens=1" %%i in (`wsl hostname -I`) do set WSLIP=%%i
if "%WSLIP%"=="" (
  echo [X] 取不到 WSL IP，请确认 WSL 正在运行
  pause & exit /b 1
)
echo WSL IP: %WSLIP%

REM 清掉旧规则再添加（幂等）
netsh interface portproxy delete v4tov4 listenport=3777 listenaddress=0.0.0.0 >nul 2>nul
netsh interface portproxy add v4tov4 listenport=3777 listenaddress=0.0.0.0 connectport=3777 connectaddress=%WSLIP%
if %errorlevel% neq 0 (
  echo [X] 端口转发失败：请右键本文件 -^> 以管理员身份运行
  pause & exit /b 1
)
netsh advfirewall firewall delete rule name="SocraticReader-3777" >nul 2>nul
netsh advfirewall firewall add rule name="SocraticReader-3777" dir=in action=allow protocol=TCP localport=3777 >nul

echo.
echo [OK] 完成。手机和电脑连同一个 WiFi，在 APP 里填：
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /C:"IPv4"') do (
  for /f "tokens=* delims= " %%b in ("%%a") do echo     http://%%b:3777
)
echo.
echo （上面若有多个地址，选 192.168 开头的那个）
echo.
echo 提示：电脑或 WSL 重启后，WSL 的 IP 会变，重新运行本脚本即可。
pause
