#!/bin/bash
# Offline safety test for the knowledge/ manifest loader.
#
# This script exercises the hardening in src/lib/knowledge.ts without
# starting the full server. It spins up a throwaway knowledge directory,
# drops several intentionally-bad files into it, and asserts that
# loadManifest() refuses to start when any of them are present.
#
# It also exercises the search_knowledge / read_knowledge entry points
# through a small Node wrapper to confirm path-traversal arguments are
# rejected (manifest allowlist rules out any file not indexed by name).
#
# Usage: ./tests/knowledge-traversal.sh (from the public-agent directory)

set -u

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "${HERE}/.." && pwd)

fail=0
pass=0

report() {
  local name="$1"; local status="$2"
  if [ "$status" = "pass" ]; then
    echo "  PASS  $name"; pass=$((pass + 1))
  else
    echo "  FAIL  $name"; fail=$((fail + 1))
  fi
}

# --- helper that invokes loadManifest on a given dir and prints its verdict ---
run_load() {
  local dir="$1"
  node --input-type=module -e "
    import { loadManifest } from '${ROOT}/dist/lib/knowledge.js';
    try {
      const m = loadManifest(process.argv[1]);
      console.log('LOADED ' + m.entries.size);
      process.exit(0);
    } catch (e) {
      console.log('REJECT ' + e.message.replace(/\\s+/g, ' '));
      process.exit(1);
    }
  " "$dir" 2>&1
}

run_read() {
  local dir="$1"; local id="$2"
  node --input-type=module -e "
    import { loadManifest, readKnowledge } from '${ROOT}/dist/lib/knowledge.js';
    const m = loadManifest(process.argv[1]);
    const r = readKnowledge(m, process.argv[2]);
    console.log(r ? 'READ ok' : 'READ null');
  " "$dir" "$id" 2>&1
}

# --- ensure build output exists ---
if [ ! -f "${ROOT}/dist/lib/knowledge.js" ]; then
  echo "error: ${ROOT}/dist/lib/knowledge.js missing — run 'npm run build' first"
  exit 2
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/public-agent-knowledge-traversal.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

# --- (1) baseline: a clean directory with one good file loads successfully ---
rm -rf "${WORK}/clean"; mkdir -p "${WORK}/clean"
printf -- '---\ntitle: Good\n---\n\n# Good\n\nhello world\n' > "${WORK}/clean/good.md"
out=$(run_load "${WORK}/clean")
case "$out" in
  "LOADED 1") report "clean dir loads (1 file)" pass ;;
  *)          report "clean dir loads (1 file) got: $out" fail ;;
esac

# --- (2) a non-.md file rejects the entire manifest ---
rm -rf "${WORK}/nonmd"; mkdir -p "${WORK}/nonmd"
printf '# ok\n' > "${WORK}/nonmd/good.md"
printf 'not markdown\n' > "${WORK}/nonmd/secrets.txt"
out=$(run_load "${WORK}/nonmd")
case "$out" in
  REJECT*secrets.txt*) report "non-.md file triggers hard-fail" pass ;;
  *)                   report "non-.md file triggers hard-fail got: $out" fail ;;
esac

# --- (3) uppercase / weird filename rejects ---
rm -rf "${WORK}/case"; mkdir -p "${WORK}/case"
printf '# ok\n' > "${WORK}/case/README.MD"
out=$(run_load "${WORK}/case")
case "$out" in
  REJECT*README.MD*) report "uppercase README.MD rejected" pass ;;
  *)                 report "uppercase README.MD rejected got: $out" fail ;;
esac

# --- (4) hidden file rejects ---
rm -rf "${WORK}/hidden"; mkdir -p "${WORK}/hidden"
printf '# ok\n' > "${WORK}/hidden/.secret.md"
out=$(run_load "${WORK}/hidden")
case "$out" in
  REJECT*.secret.md*) report "hidden file rejected" pass ;;
  *)                  report "hidden file rejected got: $out" fail ;;
esac

# --- (5) symlink outside root rejects at startup ---
rm -rf "${WORK}/sym"; mkdir -p "${WORK}/sym"
printf 'outside the knowledge root\n' > "${WORK}/outside.md"
ln -s "${WORK}/outside.md" "${WORK}/sym/sneaky.md"
out=$(run_load "${WORK}/sym")
case "$out" in
  REJECT*sneaky.md*) report "symlink rejected at startup" pass ;;
  *)                 report "symlink rejected at startup got: $out" fail ;;
esac

# --- (6) oversize file rejects ---
rm -rf "${WORK}/big"; mkdir -p "${WORK}/big"
# 65536 > 64KB cap
dd if=/dev/zero of="${WORK}/big/huge.md" bs=1024 count=65 >/dev/null 2>&1
out=$(run_load "${WORK}/big")
case "$out" in
  REJECT*huge.md*) report "oversize (>64KB) file rejected" pass ;;
  *)               report "oversize (>64KB) file rejected got: $out" fail ;;
esac

# --- (7) nested subdir file rejects (only top-level allowed) ---
rm -rf "${WORK}/nested"; mkdir -p "${WORK}/nested/subdir"
printf '# nested\n' > "${WORK}/nested/subdir/inner.md"
out=$(run_load "${WORK}/nested")
# readdir returns "subdir" which is not a regular file so it should be rejected
case "$out" in
  REJECT*subdir*) report "nested subdir rejected" pass ;;
  *)              report "nested subdir rejected got: $out" fail ;;
esac

# --- (8) path-traversal argument to read_knowledge returns null (not content) ---
rm -rf "${WORK}/allow"; mkdir -p "${WORK}/allow"
printf '# good\n' > "${WORK}/allow/good.md"
out=$(run_read "${WORK}/allow" "../../../etc/passwd")
case "$out" in
  "READ null") report "read_knowledge rejects ../ traversal id" pass ;;
  *)           report "read_knowledge rejects ../ traversal id got: $out" fail ;;
esac
out=$(run_read "${WORK}/allow" "/etc/passwd")
case "$out" in
  "READ null") report "read_knowledge rejects absolute path id" pass ;;
  *)           report "read_knowledge rejects absolute path id got: $out" fail ;;
esac
out=$(run_read "${WORK}/allow" "good.md%00.md")
case "$out" in
  "READ null") report "read_knowledge rejects null-byte / weird id" pass ;;
  *)           report "read_knowledge rejects null-byte / weird id got: $out" fail ;;
esac
out=$(run_read "${WORK}/allow" "good.md")
case "$out" in
  "READ ok") report "read_knowledge reads allowlisted id" pass ;;
  *)         report "read_knowledge reads allowlisted id got: $out" fail ;;
esac

# --- (9) real sample knowledge dir still loads after all the chaos ---
out=$(run_load "${ROOT}/knowledge")
case "$out" in
  LOADED*) report "repo sample knowledge/ loads" pass ;;
  *)       report "repo sample knowledge/ loads got: $out" fail ;;
esac

echo
echo "Result: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
