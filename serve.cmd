@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "NODE_EXE="

rem 1) PATH 里的 node
for %%I in (node.exe) do if not defined NODE_EXE if exist "%%~$PATH:I" set "NODE_EXE=%%~$PATH:I"

rem 2) DeepSeek Harness 自带的 node
if not defined NODE_EXE (
  for %%P in (
    "%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
    "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
  ) do if not defined NODE_EXE if exist "%%~P" set "NODE_EXE=%%~P"
)

if defined NODE_EXE (
  echo Using node: !NODE_EXE!
  "!NODE_EXE!" serve.mjs . 8787
  goto :end
)

rem 3) 退而求其次：Python
where py >nul 2>nul && (
  echo Using Python launcher...
  py -m http.server 8787 --bind 127.0.0.1
  goto :end
)
where python >nul 2>nul && (
  echo Using Python...
  python -m http.server 8787 --bind 127.0.0.1
  goto :end
)

echo.
echo   [错误] 没找到 Node.js 或 Python。
echo   装一个 Node.js（https://nodejs.org）后重新双击本文件即可。
echo.
pause

:end
endlocal
