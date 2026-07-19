#!/usr/bin/env bash
set -euo pipefail

root="${1:-}"
if [[ -z "$root" || "$root" != /* ]]; then
  echo "Codex bootstrap validation requires an absolute project root." >&2
  exit 64
fi

config_path="$root/.codex/config.toml"
hooks_path="$root/.codex/hooks.json"
gitignore_path="$root/.gitignore"
hook_launcher_path="$root/scripts/context/refresh-context-index-on-stop.sh"
hook_script_path="$root/scripts/context/refresh-context-index-on-stop.mjs"
if [[ -L "$config_path" || ! -f "$config_path" ]]; then
  echo "Project .codex/config.toml must be a real file before Codex can start." >&2
  exit 1
fi
if [[ -L "$hooks_path" || ! -f "$hooks_path" ]]; then
  echo "Project .codex/hooks.json must be a real file before Codex can start." >&2
  exit 1
fi
expected_hooks_json='{
  "description": "Keep the bootstrapped local context index current between Codex turns.",
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash scripts/context/refresh-context-index-on-stop.sh",
            "timeout": 600,
            "statusMessage": "Refreshing local context index"
          }
        ]
      }
    ]
  }
}'
if [[ "$(<"$hooks_path")" != "$expected_hooks_json" ]]; then
  echo "Project .codex/hooks.json must contain exactly the supported Stop hook." >&2
  exit 1
fi
if [[ -L "$gitignore_path" || ! -f "$gitignore_path" ]]; then
  echo "Repository-root Codex runtime ignore policy must be a real file before Codex can start." >&2
  exit 1
fi
if [[ -L "$hook_launcher_path" || ! -f "$hook_launcher_path" ]]; then
  echo "Project context-index Stop hook launcher must be a real file before Codex can start." >&2
  exit 1
fi
if [[ -L "$hook_script_path" || ! -f "$hook_script_path" ]]; then
  echo "Project context-index Stop hook must be a real file before Codex can start." >&2
  exit 1
fi

gitignore_has_exact_line() {
  local expected="$1"
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == "$expected" ]] && return 0
  done < "$gitignore_path"
  return 1
}

required_codex_ignore_patterns=(
  '/.tmp'
  '/cache'
  '/log'
  '/logs'
  '/memories'
  '/plugins'
  '/sessions'
  '/shell_snapshots'
  '/skills'
  '/tmp'
  '/.personality_migration'
  '/auth.json'
  '/config.toml'
  '/history.jsonl'
  '/installation_id'
  '/models_cache.json'
  '/version.json'
  '/goals_*.sqlite*'
  '/logs_*.sqlite*'
  '/memories_*.sqlite*'
  '/state_*.sqlite*'
  '.codex/*'
  '!.codex/'
  '!.codex/config.toml'
  '!.codex/hooks.json'
  '!.codex/README.md'
  '!.codex/agents/'
  '.codex/agents/*'
  '!.codex/agents/*.toml'
)
for required_pattern in "${required_codex_ignore_patterns[@]}"; do
  if ! gitignore_has_exact_line "$required_pattern"; then
    echo "Repository-root Codex runtime ignore policy is incomplete." >&2
    exit 1
  fi
done

runtime_probe_paths=(
  '.tmp'
  '.tmp/runtime-state'
  'cache'
  'cache/runtime-state'
  'log'
  'log/runtime-state'
  'logs'
  'logs/runtime-state'
  'memories'
  'memories/runtime-state'
  'plugins'
  'plugins/runtime-state'
  'sessions'
  'sessions/runtime-state'
  'shell_snapshots'
  'shell_snapshots/runtime-state'
  'skills'
  'skills/runtime-state'
  'tmp'
  'tmp/runtime-state'
  '.personality_migration'
  'auth.json'
  'config.toml'
  'history.jsonl'
  'installation_id'
  'models_cache.json'
  'version.json'
  'goals_1.sqlite'
  'goals_1.sqlite-shm'
  'goals_1.sqlite-wal'
  'logs_1.sqlite'
  'logs_1.sqlite-shm'
  'logs_1.sqlite-wal'
  'memories_1.sqlite'
  'memories_1.sqlite-shm'
  'memories_1.sqlite-wal'
  'state_1.sqlite'
  'state_1.sqlite-shm'
  'state_1.sqlite-wal'
  '.codex/auth.json'
  '.codex/cache/runtime-state'
  '.codex/sessions/runtime-state'
  '.codex/skills/runtime-state'
  '.codex/agents/extra.json'
  '.codex/agents/nested/extra.toml'
)
portable_probe_paths=(
  '.codex/README.md'
  '.codex/config.toml'
  '.codex/hooks.json'
  '.codex/agents/default.toml'
)

temporary_git_root=""
cleanup_ignore_probe() {
  if [[ -n "$temporary_git_root" && -d "$temporary_git_root" && ! -L "$temporary_git_root" ]]; then
    rm -rf -- "$temporary_git_root"
  fi
}
trap cleanup_ignore_probe EXIT
if ! command -v git >/dev/null 2>&1; then
  echo "Repository-root Codex runtime ignore policy requires Git." >&2
  exit 1
fi
temporary_git_root="$(mktemp -d "${TMPDIR:-/tmp}/codex-ignore-contract.XXXXXX")" || {
  echo "Repository-root Codex runtime ignore policy could not create an isolated probe." >&2
  exit 1
}
if ! GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
  git init --bare --quiet "$temporary_git_root/git" >/dev/null 2>&1; then
  echo "Repository-root Codex runtime ignore policy could not initialize its isolated probe." >&2
  exit 1
fi
is_effectively_ignored() {
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
    git --git-dir="$temporary_git_root/git" --work-tree="$root" \
      -c core.excludesFile= check-ignore --no-index --quiet -- "$1" >/dev/null 2>&1
}
for runtime_probe in "${runtime_probe_paths[@]}"; do
  if ! is_effectively_ignored "$runtime_probe"; then
    echo "Repository-root Codex runtime ignore policy is ineffective." >&2
    exit 1
  fi
done
for portable_probe in "${portable_probe_paths[@]}"; do
  if is_effectively_ignored "$portable_probe"; then
    echo "Portable project Codex configuration is unexpectedly ignored." >&2
    exit 1
  fi
done

allowed=(
  project_doc_max_bytes
  project_doc_fallback_filenames
  model_reasoning_effort
  model_verbosity
  web_search
  model
  service_tier
  approvals_reviewer
  approval_policy
  sandbox_mode
  network_access
  agents.max_threads
  agents.max_depth
  features.hooks
  features.memories
  features.network_proxy
  features.prevent_idle_sleep
  tui.status_line
  tui.status_line_use_colors
  tui.terminal_title
  tui.theme
)
required=()
seen=()
seen_tables=()

contains_value() {
  local expected="$1"
  shift
  local candidate
  for candidate in "$@"; do
    [[ "$candidate" == "$expected" ]] && return 0
  done
  return 1
}

for key in "${allowed[@]}"; do
  if [[ "$key" != "service_tier" ]]; then
    required[${#required[@]}]="$key"
  fi
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
    if contains_value "$table" "${seen_tables[@]}"; then
      echo "Project Codex config line $line_number duplicates table $table." >&2
      exit 1
    fi
    seen_tables[${#seen_tables[@]}]="$table"
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
  if ! contains_value "$full_key" "${allowed[@]}"; then
    echo "Project Codex config line $line_number uses unsupported key $full_key." >&2
    exit 1
  fi
  if contains_value "$full_key" "${seen[@]}"; then
    echo "Project Codex config line $line_number duplicates key $full_key." >&2
    exit 1
  fi
  if [[ "$full_key" == "features.hooks" && "$value" != "true" ]]; then
    echo "Project Codex config must enable lifecycle hooks." >&2
    exit 1
  fi
  seen[${#seen[@]}]="$full_key"
done < "$config_path"

for key in "${required[@]}"; do
  if ! contains_value "$key" "${seen[@]}"; then
    echo "Project Codex config is missing required key $key." >&2
    exit 1
  fi
done
