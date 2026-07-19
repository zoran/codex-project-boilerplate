#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
root="$(cd "$script_dir/../.." && pwd -P)"

if [[ ! -e "$root/.context-index" && ! -L "$root/.context-index" ]]; then
  exit 0
fi

cd "$root"

failure_message='{"systemMessage":"Automatic context index refresh failed. Run pnpm context:index before relying on semantic retrieval."}'
output=""
if ! output="$(
  env \
    -u CONTEXT_INDEX_DIRECTORY \
    -u CONTEXT_INDEX_DOCS_ONLY \
    -u CONTEXT_INDEX_EMBEDDING_BATCH_SIZE \
    -u CONTEXT_INDEX_LOCK_TIMEOUT_MS \
    -u CONTEXT_INDEX_MAX_FILE_BYTES \
    -u CONTEXT_INDEX_MAX_SOURCE_FILES \
    -u CONTEXT_INDEX_MAX_TOTAL_BYTES \
    -u CONTEXT_INDEX_MODEL_CACHE \
    -u CONTEXT_INDEX_OFFLINE \
    -u CONTEXT_INDEX_ONNX_THREADS \
    -u CONTEXT_INDEX_ROOT \
    -u CONTEXT_INDEX_SANITIZED_WORKER \
    -u CONTEXT_INDEX_STALE_LOCK_MS \
    -u CONTEXT_INDEX_TEST_MODE \
    -u CONTEXT_INDEX_TRACKED_ONLY \
    mise exec --locked -- node scripts/context/refresh-context-index-on-stop.mjs 2>&1
)"; then
  printf '%s\n' "$failure_message"
  exit 0
fi
if [[ -n "$output" ]]; then
  printf '%s\n' "$failure_message"
fi
exit 0
