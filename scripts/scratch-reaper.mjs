#!/usr/bin/env node
import { runSafeDiskReclaim } from "../dist/disk-reclaim.js";

const result = runSafeDiskReclaim({
  checkoutRoots: [
    "/Users/kilgore/Dropbox/Code/roger/worktrees",
    "/Users/kilgore/Dropbox/Code/cane/.worktrees",
    "/Users/kilgore/Dropbox/Code/cane/id-agents/.worktrees",
  ],
});
process.stdout.write(`${JSON.stringify(result)}\n`);
