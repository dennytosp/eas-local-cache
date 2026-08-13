#!/usr/bin/env bash
set -euo pipefail

platform="${1:-}"
if [[ "$platform" != "ios" && "$platform" != "android" ]]; then
  echo "Usage: test-cache-environment.sh ios|android" >&2
  exit 2
fi

run_id="$(date +%s)-${RANDOM}-${RANDOM}"
environment_key="m4-${platform}-${run_id}"
log_dir="$(mktemp -d "${TMPDIR:-/tmp}/eas-local-cache-environment.XXXXXX")"
cache_root=".expo/cache/eas-local-cache/v1"
before_stats="$(node ../build/cli-bin.js stats --project-root . --json)"

cleanup() {
  if [[ "$log_dir" == "${TMPDIR:-/tmp}/eas-local-cache-environment."* ]]; then
    rm -rf "$log_dir"
  fi
}
trap cleanup EXIT

run_build() {
  local label="$1"
  shift
  local device_args=()
  if [[ -n "${EAS_LOCAL_CACHE_TEST_DEVICE:-}" ]]; then
    device_args=(--device "$EAS_LOCAL_CACHE_TEST_DEVICE")
  fi
  EAS_LOCAL_CACHE_TEST_ENVIRONMENT_KEY="$environment_key" \
    bunx expo "run:${platform}" "${device_args[@]}" \
      --no-bundler --no-install "$@" 2>&1 | tee "$log_dir/${label}.log"
}

if [[ "$platform" == "ios" ]]; then
  run_build a-miss --configuration Debug
  run_build a-hit --configuration Debug
  run_build b-miss --configuration Release
  run_build b-hit --configuration Release
else
  run_build a-miss --variant debug
  run_build a-hit --variant debug
  run_build b-miss --variant debug --all-arch
  run_build b-hit --variant debug --all-arch
fi

grep -q "Cache miss for ${platform}" "$log_dir/a-miss.log"
grep -q "Cache hit for ${platform}" "$log_dir/a-hit.log"
grep -q "Cache miss for ${platform}" "$log_dir/b-miss.log"
grep -Eqi "build configuration|architecture selection" "$log_dir/b-miss.log"
grep -q "Cache hit for ${platform}" "$log_dir/b-hit.log"

after_stats="$(node ../build/cli-bin.js stats --project-root . --json)"
node -e '
  const before = JSON.parse(process.argv[1]).telemetry;
  const after = JSON.parse(process.argv[2]).telemetry;
  const delta = (field) => after[field] - before[field];
  if (delta("hits") !== 2 || delta("misses") !== 2 || delta("errors") !== 0) {
    throw new Error(
      `Expected telemetry delta hits=2, misses=2, errors=0; received hits=${delta("hits")}, misses=${delta("misses")}, errors=${delta("errors")}`
    );
  }
' "$before_stats" "$after_stats"

if rg --quiet --fixed-strings --glob '*.json' \
  -e "$environment_key" "$cache_root/events" "$cache_root/entries"; then
  echo "Raw environment key leaked into diagnostic metadata" >&2
  exit 1
fi

node ../build/cli-bin.js doctor --project-root .
echo "Verified ${platform} environment-separated miss/hit flow and diagnostic privacy."
