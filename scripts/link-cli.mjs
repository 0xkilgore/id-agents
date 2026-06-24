#!/usr/bin/env node
// Link the id-agents CLI bins onto PATH so agents can run `id-agents <subcmd>`
// (notably `id-agents promote-to-main`). The package declares `bin` entries but
// they are never globally linked, so `which id-agents` returns NOT FOUND on every
// agent shell — every builder then falls back to hand-rolled `git push` for
// promotion (no atomic verify→merge→push→remote-tip check). This runs as a
// postbuild step so the link survives rebuilds.
//
// We link into the MANAGER node's bin dir (dirname of /opt/homebrew/bin/node),
// which is on the agents' PATH. The CLI shebang is `#!/usr/bin/env node`; the CLI
// itself loads no native module (it talks to the manager over HTTP and the
// promote path is pure git), so it runs fine under whatever node resolves first.
//
// Non-fatal: a link failure (e.g. read-only bin dir in CI) warns but never wedges
// a build — the build artifacts are still valid; only the convenience link is
// skipped.

import { readFileSync, existsSync, lstatSync, unlinkSync, symlinkSync, chmodSync, readlinkSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { managerNode } from "./native-node.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binDir = dirname(managerNode()); // e.g. /opt/homebrew/bin — on agents' PATH

function linkOne(name, relTarget) {
  const target = resolve(repoRoot, relTarget);
  if (!existsSync(target)) {
    console.warn(`[link-cli] skip ${name}: target missing (${target}) — run the build first`);
    return false;
  }
  // Ensure the entry is executable (the shebang is only honored on an +x file).
  try { chmodSync(target, 0o755); } catch { /* best-effort */ }

  const linkPath = join(binDir, name);
  // Idempotent: if the link already points at our target, do nothing.
  try {
    if (lstatSync(linkPath).isSymbolicLink() && readlinkSync(linkPath) === target) {
      console.log(`[link-cli] ${name} already linked -> ${target}`);
      return true;
    }
    unlinkSync(linkPath); // stale link/file — replace it
  } catch { /* nothing there yet */ }

  symlinkSync(target, linkPath);
  console.log(`[link-cli] linked ${linkPath} -> ${target}`);
  return true;
}

try {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const bins = pkg.bin ?? {};
  let ok = true;
  for (const [name, rel] of Object.entries(bins)) ok = linkOne(name, rel) && ok;
  if (!ok) console.warn(`[link-cli] one or more bins not linked (non-fatal)`);
} catch (err) {
  // Never fail the build over the convenience link.
  console.warn(`[link-cli] non-fatal: ${err instanceof Error ? err.message : String(err)}`);
}
