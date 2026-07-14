#!/usr/bin/env bash
set -euo pipefail

root="${1:-}"
if [[ -z "$root" || "$root" != /* ]]; then
  echo "Codex bootstrap validation requires an absolute project root." >&2
  exit 64
fi

config_path="$root/.codex/config.toml"
if [[ -L "$config_path" || ! -f "$config_path" ]]; then
  echo "Project .codex/config.toml must be a real file before Codex can start." >&2
  exit 1
fi

declare -A allowed=()
declare -A required=()
declare -A seen=()
declare -A seen_tables=()

for key in \
  project_doc_max_bytes \
  project_doc_fallback_filenames \
  model_reasoning_effort \
  model_verbosity \
  web_search \
  model \
  service_tier \
  approvals_reviewer \
  approval_policy \
  sandbox_mode \
  network_access \
  agents.max_threads \
  agents.max_depth \
  features.hooks \
  features.memories \
  features.network_proxy \
  features.prevent_idle_sleep \
  tui.status_line \
  tui.status_line_use_colors \
  tui.terminal_title \
  tui.theme; do
  allowed["$key"]=1
done

for key in "${!allowed[@]}"; do
  [[ "$key" == "service_tier" ]] || required["$key"]=1
done

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

table=""
line_number=0
while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
  line_number=$((line_number + 1))
  line="$(trim "${raw_line%%#*}")"
  [[ -n "$line" ]] || continue

  if [[ "$line" =~ ^\[([A-Za-z_][A-Za-z0-9_-]*)\]$ ]]; then
    table="${BASH_REMATCH[1]}"
    case "$table" in
      agents | features | tui) ;;
      *)
        echo "Project Codex config line $line_number defines an unsupported table." >&2
        exit 1
        ;;
    esac
    if [[ -v "seen_tables[$table]" ]]; then
      echo "Project Codex config line $line_number duplicates table $table." >&2
      exit 1
    fi
    seen_tables["$table"]=1
    continue
  fi
  if [[ "$line" == \[* ]]; then
    echo "Project Codex config line $line_number defines an unsupported table." >&2
    exit 1
  fi

  if [[ ! "$line" =~ ^([A-Za-z_][A-Za-z0-9_-]*)[[:space:]]*=(.*)$ ]]; then
    echo "Project Codex config line $line_number is not a supported assignment." >&2
    exit 1
  fi
  local_key="${BASH_REMATCH[1]}"
  value="$(trim "${BASH_REMATCH[2]}")"
  if [[ -z "$value" ]]; then
    echo "Project Codex config line $line_number has no value." >&2
    exit 1
  fi
  full_key="${table:+$table.}$local_key"
  if [[ ! -v "allowed[$full_key]" ]]; then
    echo "Project Codex config line $line_number uses unsupported key $full_key." >&2
    exit 1
  fi
  if [[ -v "seen[$full_key]" ]]; then
    echo "Project Codex config line $line_number duplicates key $full_key." >&2
    exit 1
  fi
  seen["$full_key"]=1
done < "$config_path"

for key in "${!required[@]}"; do
  if [[ ! -v "seen[$key]" ]]; then
    echo "Project Codex config is missing required key $key." >&2
    exit 1
  fi
done
