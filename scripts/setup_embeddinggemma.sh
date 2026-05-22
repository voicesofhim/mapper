#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${EMBEDDINGGEMMA_VENV:-"${ROOT_DIR}/.venv-embeddinggemma"}"
MODEL_ID="${EMBEDDINGGEMMA_MODEL:-google/embeddinggemma-300M}"
MODEL_DIR="${EMBEDDINGGEMMA_MODEL_DIR:-"${ROOT_DIR}/models/embeddinggemma-300m"}"
PYTHON_BIN="${PYTHON:-python3}"
SKIP_DOWNLOAD=0

usage() {
  cat <<USAGE
Usage: npm run setup:embeddinggemma -- [options]

Options:
  --model MODEL_ID        Hugging Face model id. Default: ${MODEL_ID}
  --model-dir PATH        Local model directory. Default: ${MODEL_DIR}
  --venv PATH             Python venv directory. Default: ${VENV_DIR}
  --skip-download         Install dependencies and auth-check only.
  -h, --help              Show this help.

Environment:
  HF_TOKEN                Optional Hugging Face token for non-interactive login.
  EMBEDDINGGEMMA_MODEL    Override the model id.
  EMBEDDINGGEMMA_MODEL_DIR Override the local model directory.
  EMBEDDINGGEMMA_VENV     Override the venv directory.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)
      MODEL_ID="$2"
      shift 2
      ;;
    --model-dir)
      MODEL_DIR="$2"
      shift 2
      ;;
    --venv)
      VENV_DIR="$2"
      shift 2
      ;;
    --skip-download)
      SKIP_DOWNLOAD=1
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

mkdir -p "$(dirname "${VENV_DIR}")" "$(dirname "${MODEL_DIR}")"

if [[ ! -x "${VENV_DIR}/bin/python" ]]; then
  echo "[embeddinggemma] Creating venv: ${VENV_DIR}"
  "${PYTHON_BIN}" -m venv "${VENV_DIR}"
fi

echo "[embeddinggemma] Installing local Python dependencies"
"${VENV_DIR}/bin/python" -m pip install --upgrade pip
"${VENV_DIR}/bin/python" -m pip install -r "${ROOT_DIR}/requirements-embeddinggemma.txt"

HF_BIN="${VENV_DIR}/bin/hf"
if [[ ! -x "${HF_BIN}" ]]; then
  echo "[embeddinggemma] Expected Hugging Face CLI at ${HF_BIN}, but it was not installed." >&2
  exit 1
fi

if [[ -n "${HF_TOKEN:-}" ]]; then
  echo "[embeddinggemma] Logging in with HF_TOKEN from the local environment"
  "${HF_BIN}" auth login --token "${HF_TOKEN}" >/dev/null
fi

AUTH_STATUS="$("${HF_BIN}" auth whoami 2>&1 || true)"
if [[ "${AUTH_STATUS}" == *"Not logged in"* || "${AUTH_STATUS}" == *"Invalid user token"* || "${AUTH_STATUS}" == *"Token is invalid"* ]]; then
  echo "[embeddinggemma] Hugging Face login is required to access Gemma-gated weights."
  echo "[embeddinggemma] First accept access for ${MODEL_ID} at https://huggingface.co/google/embeddinggemma-300m if your account has not already done so."
  echo "[embeddinggemma] A browser/token prompt may open. Do not commit or paste the token into repo files."
  "${HF_BIN}" auth login
fi

if [[ "${SKIP_DOWNLOAD}" == "1" ]]; then
  echo "[embeddinggemma] Setup complete. Skipped model download."
  exit 0
fi

echo "[embeddinggemma] Downloading ${MODEL_ID} to ${MODEL_DIR}"
mkdir -p "${MODEL_DIR}"
if ! "${HF_BIN}" download "${MODEL_ID}" --local-dir "${MODEL_DIR}"; then
  cat >&2 <<ERROR
[embeddinggemma] Download failed.

Most likely causes:
  1. The local Hugging Face account has not accepted the Gemma/EmbeddingGemma license.
  2. The local Hugging Face token is missing or does not have access to gated models.
  3. The token was not saved by 'hf auth login'.

Fix locally, without committing secrets:
  .venv-embeddinggemma/bin/hf auth login
  npm run setup:embeddinggemma
ERROR
  exit 1
fi

echo "[embeddinggemma] Verifying local sidecar help"
"${VENV_DIR}/bin/python" "${ROOT_DIR}/scripts/embed_embeddinggemma.py" --help >/dev/null

cat <<DONE
[embeddinggemma] Done.

Run the importer with:

  npm run import:accelerator -- \\
    --embedding-provider embeddinggemma \\
    --embedding-model ${MODEL_DIR} \\
    --embedding-command ${VENV_DIR}/bin/python \\
    --embedding-dimensions 768
DONE
