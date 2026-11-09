@echo off
REM ============================================================
REM  D: disk read-only health check - launcher (ASCII comments on purpose)
REM  NOTE: cmd.exe reads .cmd files with the OEM code page (936/GBK on a
REM        Chinese Windows), so Chinese comments here would be mojibake.
REM        The command line itself is pure ASCII, so it is unaffected.
REM  NOTE: the .ps1 resolves the repo root from its own location, so this
REM        launcher works from ANY working directory.
REM  NOTE: the .ps1 self-elevates (asks for admin via UAC) when needed.
REM
REM  Usage:
REM    scripts\diagnose-disk-health.cmd
REM    scripts\diagnose-disk-health.cmd -SkipChkdsk
REM    scripts\diagnose-disk-health.cmd -SkipChkdsk -SkipDirScan -NoPause
REM ============================================================
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0diagnose-disk-health.ps1" %*
exit /b %ERRORLEVEL%
