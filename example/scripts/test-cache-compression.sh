#!/usr/bin/env bash
set -euo pipefail

platform="${1:-}"
if [[ "$platform" != "ios" && "$platform" != "android" ]]; then
  echo "Usage: test-cache-compression.sh ios|android" >&2
  exit 2
fi

if ! node -e '
  const childProcess = require("node:child_process");
  const zlib = require("node:zlib");
  const hasNodeCodec =
    typeof zlib.createZstdCompress === "function" &&
    typeof zlib.createZstdDecompress === "function";
  const cli = childProcess.spawnSync("zstd", ["-V"], {
    stdio: "ignore",
    timeout: 2_000,
  });
  process.exit(hasNodeCodec || cli.status === 0 ? 0 : 1);
'; then
  echo "Compression test requires Node built-in zstd support or zstd on PATH." >&2
  exit 1
fi

run_id="$(date +%s)-${RANDOM}-${RANDOM}"
test_salt="m5-compression-${platform}-${run_id}"
log_dir="$(mktemp -d "${TMPDIR:-/tmp}/eas-local-cache-compression.XXXXXX")"
cache_root=".expo/cache/eas-local-cache/v1"
started_at_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
before_stats="$(node ../build/cli-bin.js stats --project-root . --json)"

cleanup() {
  if [[ "$log_dir" == "${TMPDIR:-/tmp}/eas-local-cache-compression."* ]]; then
    rm -rf "$log_dir"
  fi
}
trap cleanup EXIT

run_build() {
  local label="$1"
  local device_args=()
  if [[ -n "${EAS_LOCAL_CACHE_TEST_DEVICE:-}" ]]; then
    device_args=(--device "$EAS_LOCAL_CACHE_TEST_DEVICE")
  fi
  EAS_LOCAL_CACHE_TEST_COMPRESSION=zstd \
    EAS_LOCAL_CACHE_TEST_SALT="$test_salt" \
    bunx expo "run:${platform}" "${device_args[@]}" \
      --no-bundler --no-install 2>&1 | tee "$log_dir/${label}.log"
}

run_build compressed-miss
run_build compressed-hit

grep -q "Cache miss for ${platform}" "$log_dir/compressed-miss.log"
grep -q "Cached ${platform} build at .*\.zst" "$log_dir/compressed-miss.log"
grep -q "Cache hit for ${platform}" "$log_dir/compressed-hit.log"
grep -q "/restores/${platform}/" "$log_dir/compressed-hit.log"

owned_list="$(node ../build/cli-bin.js list --project-root . --platform "$platform" --json)"
owned_entry_id="$(node -e '
  const list = JSON.parse(process.argv[1]);
  const startedAtMs = Number(process.argv[2]);
  const candidates = list.entries.filter(
    (entry) =>
      entry.encoding === "zstd" &&
      Date.parse(entry.createdAt) >= startedAtMs
  );
  if (candidates.length !== 1 || !/^[a-f0-9]{64}$/.test(candidates[0].entryId)) {
    throw new Error(`Expected exactly one owned compressed entry; received ${candidates.length}`);
  }
  process.stdout.write(candidates[0].entryId);
' "$owned_list" "$started_at_ms")"
owned_restore="$cache_root/restores/$platform/$owned_entry_id"
if [[ ! -d "$owned_restore" || -L "$owned_restore" ]]; then
  echo "Owned restore is missing or unsafe: $owned_restore" >&2
  exit 1
fi
rm -rf -- "$owned_restore"
if [[ -e "$owned_restore" || -L "$owned_restore" ]]; then
  echo "Could not remove the owned restore: $owned_restore" >&2
  exit 1
fi

run_build compressed-rematerialized-hit
grep -q "Cache hit for ${platform}" "$log_dir/compressed-rematerialized-hit.log"
grep -q "/restores/${platform}/${owned_entry_id}/" "$log_dir/compressed-rematerialized-hit.log"
if [[ ! -d "$owned_restore" || -L "$owned_restore" ]]; then
  echo "The identical third build did not rematerialize its owned restore" >&2
  exit 1
fi

after_stats="$(node ../build/cli-bin.js stats --project-root . --json)"
after_list="$(node ../build/cli-bin.js list --project-root . --platform "$platform" --json)"
node -e '
  const before = JSON.parse(process.argv[1]);
  const after = JSON.parse(process.argv[2]);
  const list = JSON.parse(process.argv[3]);
  const startedAtMs = Number(process.argv[4]);
  const delta = (field) => after.telemetry[field] - before.telemetry[field];
  if (delta("hits") !== 2 || delta("misses") !== 1 || delta("errors") !== 0) {
    throw new Error(
      `Expected telemetry delta hits=2, misses=1, errors=0; received hits=${delta("hits")}, misses=${delta("misses")}, errors=${delta("errors")}`
    );
  }
  const compressed = list.entries.find(
    (entry) =>
      entry.encoding === "zstd" &&
      Date.parse(entry.createdAt) >= startedAtMs
  );
  if (
    !compressed ||
    compressed.logicalArtifactBytes <= 0 ||
    compressed.payloadBytes <= 0 ||
    compressed.grossCompressionSavedBytes <= 0 ||
    compressed.restoreBytes <= 0
  ) {
    throw new Error("The native oracle did not publish and restore a new compressed entry");
  }
  if (
    after.compression.compressedEntries < 1 ||
    after.compression.grossSavedBytes <= 0 ||
    after.compression.restoreBytes <= 0
  ) {
    throw new Error("Cache stats did not account for the compressed entry and restore");
  }
' "$before_stats" "$after_stats" "$after_list" "$started_at_ms"

if rg --quiet --fixed-strings --glob '*.json' \
  -e "$test_salt" "$cache_root/events" "$cache_root/entries"; then
  echo "Raw compression test salt leaked into diagnostic metadata" >&2
  exit 1
fi

node ../build/cli-bin.js doctor --project-root .
echo "Verified ${platform} compressed miss/restore-hit/rematerialized-hit flow, accounting, and health."
