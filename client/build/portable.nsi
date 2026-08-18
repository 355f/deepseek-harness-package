; DeepSeek Harness portable single-file wrapper
; - First run: extract staging-clean/app to %LOCALAPPDATA%\DeepSeek Harness\app-<TAG>, write marker
; - Subsequent runs: marker exists, skip extract, Exec directly (instant start)
; - Version bump: TAG changes, marker name changes, auto re-extracts

Unicode True

!define APP_VERSION "0.1.0-rc.6.2"
!define EXTRACT_TAG "${APP_VERSION}"

Name "DeepSeek Harness"
OutFile "DeepSeek-Harness-${APP_VERSION}-portable.exe"
RequestExecutionLevel user
SetCompressor /SOLID lzma
Icon "icon.ico"

SilentInstall silent
AutoCloseWindow true

!define MARKER ".extracted-${EXTRACT_TAG}"

Section
  ; Persistent dir (LOCALAPPDATA survives; TEMP gets cleaned)
  StrCpy $0 "$LOCALAPPDATA\DeepSeek Harness\app-${EXTRACT_TAG}"
  SetOutPath "$0"

  ; marker exists => already extracted, launch immediately (instant start)
  IfFileExists "$0\${MARKER}" launch

  ; First-time extract (or re-extract after version bump)
  File /r "..\staging-clean\app\*"
  FileOpen $1 "$0\${MARKER}" w
  FileWrite $1 "extracted ${EXTRACT_TAG}"
  FileClose $1

launch:
  ; Pass the portable exe path so the app can self-update (replace this file)
  Exec '"$0\DeepSeek Harness.exe" --portable-exe="$EXEPATH"'
SectionEnd
