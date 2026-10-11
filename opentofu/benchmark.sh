#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
TOFU_SRC="$PWD"
TF_SRC="$(cd ../terraform 2>/dev/null && pwd || true)"

TOFU="${TOFU:-tofu}"
TERRAFORM="${TERRAFORM:-terraform}"
RUNS="${RUNS:-3}"
ONLY="both"
REPORT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --runs)   RUNS="$2"; shift 2 ;;
    --report) REPORT="$2"; shift 2 ;;
    --only)   ONLY="$2"; shift 2 ;;
    *) echo "usage: $0 [--runs N] [--only tofu|terraform] [--report FILE]" >&2; exit 2 ;;
  esac
done

aws sts get-caller-identity >/dev/null 2>&1 || {
  echo "AWS credentials are not working. plan reads caller identity and availability zones, so it needs them." >&2
  exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

declare -A RESULT
TOOLS=()

now_ms() { date +%s%3N; }

fmt() { printf '%d.%02ds' $(($1 / 1000)) $((($1 % 1000) / 10)); }

median() {
  local sorted
  sorted=$(printf '%s\n' "$@" | sort -n)
  local n=$#
  echo "$sorted" | sed -n "$(((n / 2) + 1))p"
}

timed() {
  local dir="$1" log="$2"
  shift 2
  local t0 t1
  t0=$(now_ms)
  if ! (cd "$dir" && "$@") >"$log" 2>&1; then
    echo >&2
    echo "failed: $*" >&2
    tail -n 20 "$log" >&2
    exit 1
  fi
  t1=$(now_ms)
  echo $((t1 - t0))
}

bench() {
  local tool="$1" bin="$2" src="$3" ext="$4"
  local dir="$WORK/$tool" cache="$WORK/cache-$tool"

  mkdir -p "$dir" "$cache"
  cp "$src"/*."$ext" "$dir"/

  export TF_PLUGIN_CACHE_DIR="$cache"
  export TF_IN_AUTOMATION=1

  echo "==> $tool: cold init"
  RESULT["$tool.init_cold"]=$(timed "$dir" "$WORK/$tool-init-cold.log" "$bin" init -input=false -no-color)

  local -a inits=() validates=() plans=()
  local i
  for i in $(seq 1 "$RUNS"); do
    echo "==> $tool: run $i of $RUNS"
    rm -rf "$dir/.terraform" "$dir/.terraform.lock.hcl"
    inits+=("$(timed "$dir" "$WORK/$tool-init.log" "$bin" init -input=false -no-color)")
    validates+=("$(timed "$dir" "$WORK/$tool-validate.log" "$bin" validate -no-color)")
    plans+=("$(timed "$dir" "$WORK/$tool-plan.log" "$bin" plan -input=false -lock=false -no-color)")
  done

  RESULT["$tool.init"]=$(median "${inits[@]}")
  RESULT["$tool.validate"]=$(median "${validates[@]}")
  RESULT["$tool.plan"]=$(median "${plans[@]}")
  RESULT["$tool.version"]=$( (cd "$dir" && "$bin" version) | head -n 1)
  RESULT["$tool.resources"]=$(grep -hE '^(resource|data) ' "$dir"/*."$ext" | wc -l | tr -d ' ')
  TOOLS+=("$tool")
}

if [ "$ONLY" != "tofu" ]; then
  if [ -n "$TF_SRC" ] && command -v "$TERRAFORM" >/dev/null; then
    bench terraform "$TERRAFORM" "$TF_SRC" tf
  else
    echo "skipping terraform: no ../terraform directory or no terraform in PATH"
  fi
fi

if [ "$ONLY" != "terraform" ]; then
  if command -v "$TOFU" >/dev/null; then
    bench opentofu "$TOFU" "$TOFU_SRC" tofu
  else
    echo "tofu not found in PATH" >&2
    exit 1
  fi
fi

emit() {
  echo "# IaC benchmark"
  echo
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) · $RUNS runs · median of each phase · no state, defaults only"
  echo
  for tool in "${TOOLS[@]}"; do
    echo "- $tool: ${RESULT[$tool.version]} · ${RESULT[$tool.resources]} resource and data blocks"
  done
  echo
  printf '| phase |'
  for tool in "${TOOLS[@]}"; do printf ' %s |' "$tool"; done
  echo
  printf '%s' '|---|'
  for _ in "${TOOLS[@]}"; do printf '%s' '---|'; done
  echo
  for phase in init_cold init validate plan; do
    printf '| %s |' "$phase"
    for tool in "${TOOLS[@]}"; do printf ' %s |' "$(fmt "${RESULT[$tool.$phase]}")"; done
    echo
  done
  if [ "${#TOOLS[@]}" -eq 2 ]; then
    echo
    local a="${TOOLS[0]}" b="${TOOLS[1]}"
    for phase in init_cold init validate plan; do
      local x="${RESULT[$a.$phase]}" y="${RESULT[$b.$phase]}"
      if [ "$x" -gt 0 ]; then
        printf '%s: %s is %d%% of %s\n' "$phase" "$b" $((y * 100 / x)) "$a"
      fi
    done
  fi
}

echo
emit | tee "${REPORT:-/dev/null}"

if [ -n "$REPORT" ]; then
  echo
  echo "written to $REPORT"
fi
