@echo off
chcp 65001 >nul
rem Token Visualizer launcher (double-click). Usage: start.cmd [--no-open] [--port N]
rem NOTE: keep this file ASCII-only. cmd.exe mis-parses multi-byte text in batch files
rem (shifted offsets); Chinese messages live in scripts\messages\*.txt and are shown with "type".
setlocal
cd /d "%~dp0"
title Token Visualizer

if not defined TV_MIN_NODE set "TV_MIN_NODE=22.18"
where node >nul 2>nul
if errorlevel 1 goto :nonode

node -e "const need=process.env.TV_MIN_NODE.split('.').map(Number);const have=process.versions.node.split('.').map(Number);const ok=have[0]>need[0]||(have[0]===need[0]&&(have[1]||0)>=(need[1]||0));process.exit(ok?0:1)"
if errorlevel 1 goto :oldnode

node "%~dp0src\server\index.ts" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" goto :failed
exit /b 0

:failed
echo.
type "%~dp0scripts\messages\exit-error.txt"
echo Exit code: %RC%
if not defined TV_NO_PAUSE pause
exit /b %RC%

:nonode
echo.
type "%~dp0scripts\messages\no-node.txt"
if not defined TV_NO_PAUSE pause
exit /b 1

:oldnode
echo.
type "%~dp0scripts\messages\old-node.txt"
node -p "'\u5f53\u524d\u7248\u672c\uff1a'+process.versions.node+'\uff08\u9700\u8981 '+process.env.TV_MIN_NODE+' \u6216\u66f4\u9ad8\uff09'"
echo.
if not defined TV_NO_PAUSE pause
exit /b 1
