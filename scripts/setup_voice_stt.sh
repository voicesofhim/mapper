#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${MAPPER_VOICE_VENV:-"${ROOT_DIR}/.venv-voice"}"
STT_MODEL="${MAPPER_STT_MODEL:-base.en}"
PYTHON_BIN="${PYTHON:-python3}"
SKIP_MODEL=0

usage() {
  cat <<USAGE
Usage: npm run setup:voice -- [options]

Options:
  --model MODEL   faster-whisper model id/path to prefetch. Default: ${STT_MODEL}
  --venv PATH     Python venv directory. Default: ${VENV_DIR}
  --skip-model    Install dependencies only; do not prefetch the STT model.
  -h, --help      Show this help.

Environment:
  MAPPER_VOICE_VENV  Override the local voice/STT venv directory.
  MAPPER_STT_MODEL   Override the local faster-whisper model id/path.
  PYTHON             Python executable to use for venv creation.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)
      STT_MODEL="$2"
      shift 2
      ;;
    --venv)
      VENV_DIR="$2"
      shift 2
      ;;
    --skip-model)
      SKIP_MODEL=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

mkdir -p "$(dirname "${VENV_DIR}")"

if [[ ! -x "${VENV_DIR}/bin/python" ]]; then
  echo "[voice] Creating venv: ${VENV_DIR}"
  "${PYTHON_BIN}" -m venv "${VENV_DIR}"
fi

echo "[voice] Installing local LiveKit/STT dependencies"
"${VENV_DIR}/bin/python" -m pip install --upgrade pip
"${VENV_DIR}/bin/python" -m pip install -r "${ROOT_DIR}/requirements-voice.txt"

if [[ "${SKIP_MODEL}" != "1" ]]; then
  echo "[voice] Prefetching local STT model: ${STT_MODEL}"
  "${VENV_DIR}/bin/python" - "${STT_MODEL}" <<'PY'
import sys
from faster_whisper import WhisperModel

model_id = sys.argv[1]
WhisperModel(model_id, device="cpu", compute_type="int8")
print(f"[voice] Model ready: {model_id}")
PY
fi

echo "[voice] Verifying STT bridge help"
"${VENV_DIR}/bin/python" "${ROOT_DIR}/scripts/livekit_stt_bridge.py" --help >/dev/null

cat <<DONE
[voice] Done.

Run locally with:

  npm run voice:stt

You also need a local LiveKit server and the local Ask server running.
DONE
