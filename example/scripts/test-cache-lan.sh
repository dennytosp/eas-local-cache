#!/usr/bin/env bash
set -euo pipefail

platform="${1:-}"
if [[ "$platform" != "ios" && "$platform" != "android" ]]; then
  echo "Usage: test-cache-lan.sh ios|android" >&2
  exit 2
fi

run_id="$(date +%s)-${RANDOM}-${RANDOM}"
test_salt="m6-lan-${platform}-${run_id}"
work_root="$(mktemp -d "${TMPDIR:-/tmp}/eas-local-cache-lan.XXXXXX")"
server_root="$work_root/server-project"
pairing_file="$work_root/pairing.secret"
server_log="$work_root/server.log"
pair_result="$work_root/pair.json"
cache_root=".expo/cache/eas-local-cache/v1"
lan_state="$cache_root/state/lan.json"
lan_state_backup="$work_root/lan.json.backup"
server_pid=""
had_lan_state=false

if [[ -e "$lan_state" || -L "$lan_state" ]]; then
  if [[ ! -f "$lan_state" || -L "$lan_state" ]]; then
    echo "Refusing to replace an unsafe LAN state fixture: $lan_state" >&2
    exit 1
  fi
  cp -p "$lan_state" "$lan_state_backup"
  had_lan_state=true
  rm -f -- "$lan_state"
fi

cleanup() {
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill -TERM "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if [[ -e "$lan_state" || -L "$lan_state" ]]; then
    if [[ -f "$lan_state" && ! -L "$lan_state" ]]; then
      rm -f -- "$lan_state"
    else
      echo "LAN oracle left an unsafe state path; not modifying it: $lan_state" >&2
    fi
  fi
  if [[ "$had_lan_state" == true && -f "$lan_state_backup" ]]; then
    mkdir -p "$(dirname "$lan_state")"
    cp -p "$lan_state_backup" "$lan_state"
  fi
  if [[ "$work_root" == "${TMPDIR:-/tmp}/eas-local-cache-lan."* ]]; then
    rm -rf -- "$work_root"
  fi
}
trap cleanup EXIT

mkdir -p "$server_root"
started_at_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
before_stats="$(node ../build/cli-bin.js stats --project-root . --json)"

run_build() {
  local label="$1"
  local device_args=()
  if [[ -n "${EAS_LOCAL_CACHE_TEST_DEVICE:-}" ]]; then
    device_args=(--device "$EAS_LOCAL_CACHE_TEST_DEVICE")
  fi
  EAS_LOCAL_CACHE_TEST_LAN=read \
    EAS_LOCAL_CACHE_TEST_SALT="$test_salt" \
    bunx expo "run:${platform}" "${device_args[@]}" \
      --no-bundler --no-install 2>&1 | tee "$work_root/${label}.log"
}

run_build local-miss
grep -q "Cache miss for ${platform}" "$work_root/local-miss.log"
grep -q "Cached ${platform} build at" "$work_root/local-miss.log"

owned_list="$(node ../build/cli-bin.js list --project-root . --platform "$platform" --json)"
owned_entry_id="$(node -e '
  const list = JSON.parse(process.argv[1]);
  const startedAtMs = Number(process.argv[2]);
  const candidates = list.entries.filter(
    (entry) => Date.parse(entry.createdAt) >= startedAtMs
  );
  if (candidates.length !== 1 || !/^[a-f0-9]{64}$/.test(candidates[0].entryId)) {
    throw new Error(`Expected exactly one owned LAN entry; received ${candidates.length}`);
  }
  process.stdout.write(candidates[0].entryId);
' "$owned_list" "$started_at_ms")"

owned_entry="$cache_root/entries/$platform/$owned_entry_id"
server_entries="$server_root/$cache_root/entries/$platform"
if [[ ! -d "$owned_entry" || -L "$owned_entry" ]]; then
  echo "Owned LAN entry is missing or unsafe: $owned_entry" >&2
  exit 1
fi
mkdir -p "$server_entries"
chmod 700 "$server_root/$cache_root"
cp -R "$owned_entry" "$server_entries/$owned_entry_id"
rm -rf -- "$owned_entry"
rm -f -- "$cache_root/access/${owned_entry_id}.json"

node ../build/cli-bin.js serve \
  --project-root "$server_root" \
  --host 127.0.0.1 \
  --no-discovery \
  --pairing \
  --pairing-file "$pairing_file" \
  --json >"$server_log" 2>&1 &
server_pid="$!"

for _ in $(seq 1 200); do
  if [[ -f "$pairing_file" ]] && rg --quiet '"ready": true' "$server_log"; then
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    cat "$server_log" >&2
    echo "LAN cache server exited before becoming ready" >&2
    exit 1
  fi
  sleep 0.05
done
if [[ ! -f "$pairing_file" ]] || ! rg --quiet '"ready": true' "$server_log"; then
  cat "$server_log" >&2
  echo "Timed out waiting for the LAN cache server" >&2
  exit 1
fi

node ../build/cli-bin.js pair \
  --project-root . \
  --pairing-file "$pairing_file" \
  --alias native-oracle \
  --json >"$pair_result"
rg --quiet '"paired": true' "$pair_result"

run_build remote-hit
grep -q "LAN cache hit from peer" "$work_root/remote-hit.log"
grep -q "Cache hit for ${platform}" "$work_root/remote-hit.log"
if [[ ! -d "$owned_entry" || -L "$owned_entry" ]]; then
  echo "Remote hit did not atomically promote the owned cache entry" >&2
  exit 1
fi

kill -TERM "$server_pid"
wait "$server_pid"
server_pid=""
if [[ -e "$pairing_file" || -L "$pairing_file" ]]; then
  echo "Server shutdown did not remove its owned pairing file" >&2
  exit 1
fi

run_build offline-local-hit
grep -q "Cache hit for ${platform}" "$work_root/offline-local-hit.log"
if grep -q "LAN cache hit from peer" "$work_root/offline-local-hit.log"; then
  echo "Offline verification unexpectedly used the LAN peer" >&2
  exit 1
fi

after_stats="$(node ../build/cli-bin.js stats --project-root . --json)"
node -e '
  const before = JSON.parse(process.argv[1]);
  const after = JSON.parse(process.argv[2]);
  const delta = (field) => after.telemetry[field] - before.telemetry[field];
  if (delta("hits") !== 2 || delta("misses") !== 1 || delta("errors") !== 0) {
    throw new Error(
      `Expected telemetry delta hits=2, misses=1, errors=0; received hits=${delta("hits")}, misses=${delta("misses")}, errors=${delta("errors")}`
    );
  }
' "$before_stats" "$after_stats"

if rg --quiet --fixed-strings --glob '*.json' \
  -e "$test_salt" "$cache_root/events" "$cache_root/entries"; then
  echo "Raw LAN test salt leaked into diagnostic metadata" >&2
  exit 1
fi

node ../build/cli-bin.js doctor --project-root .
echo "Verified ${platform} local-miss/remote-hit/offline-local-hit flow, telemetry, and health."
