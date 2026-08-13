#!/usr/bin/env bash
set -euo pipefail

platform="${1:-}"
if [[ "$platform" != "ios" && "$platform" != "android" ]]; then
  echo "Usage: test-cache-native.sh ios|android" >&2
  exit 2
fi

run_id="$(date +%s)-${RANDOM}-${RANDOM}"
salt_a="m3-a-${run_id}"
salt_b="m3-b-${run_id}"
log_dir="$(mktemp -d "${TMPDIR:-/tmp}/eas-local-cache-native.XXXXXX")"
cache_root=".expo/cache/eas-local-cache/v1"
before_stats="$(node ../build/cli-bin.js stats --project-root . --json)"

cleanup() {
  if [[ "$log_dir" == "${TMPDIR:-/tmp}/eas-local-cache-native."* ]]; then
    rm -rf "$log_dir"
  fi
}
trap cleanup EXIT

run_build() {
  local salt="$1"
  local label="$2"
  local device_args=()
  if [[ -n "${EAS_LOCAL_CACHE_TEST_DEVICE:-}" ]]; then
    device_args=(--device "$EAS_LOCAL_CACHE_TEST_DEVICE")
  fi
  EAS_LOCAL_CACHE_TEST_SALT="$salt" bunx expo "run:${platform}" \
    "${device_args[@]}" --no-bundler --no-install 2>&1 | \
    tee "$log_dir/${label}.log"
}

run_build "$salt_a" a-miss
run_build "$salt_a" a-hit
run_build "$salt_b" b-miss
run_build "$salt_b" b-hit

grep -q "Cache miss for ${platform}" "$log_dir/a-miss.log"
grep -q "Cache hit for ${platform}" "$log_dir/a-hit.log"
grep -q "Cache miss for ${platform}" "$log_dir/b-miss.log"
grep -qi "Expo config" "$log_dir/b-miss.log"
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
  -e "$salt_a" -e "$salt_b" "$cache_root/events" "$cache_root/entries"; then
  echo "Raw cache test salt leaked into diagnostic metadata" >&2
  exit 1
fi

node ../build/cli-bin.js doctor --project-root .
echo "Verified ${platform} miss/hit/config-change/hit flow, telemetry, and diagnostic privacy."
