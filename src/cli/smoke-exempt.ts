// T-QA.7 — red-suite-blocks-all-promotions trap fix (v0 classifier).
//
// promote-to-main step 6 aborts the whole promotion on ANY non-zero smoke exit
// (exit 9), with no per-test discrimination — so one flaky/unrelated red test
// blocks every agent's promotions. This pure module lets the caller downgrade
// abort→proceed ONLY when EVERY failing test file is operator-declared exempt
// (--smoke-exempt <globs>). No globs → the classifier never says "all exempt",
// so behavior is byte-identical to today unless the operator opts in.

/** Parse the failing test FILE paths out of a vitest run's output. Looks at
 *  lines that signal failure ("FAIL ..." and the "❯ <file> (… failed)" summary
 *  rows) and extracts test-file paths from them. Conservative: a file is only
 *  reported failing if it appears on a failure-signalling line. */
export function parseFailingTestFiles(output: string): string[] {
  const FILE_RE = /([\w./@+-]+\.(?:test|spec)\.[cm]?[jt]sx?)/g;
  const found = new Set<string>();
  for (const rawLine of output.split(/\r?\n/)) {
    // Normalize Windows separators before matching so a backslash path is
    // captured as one token (backslash isn't in the file char class).
    const line = rawLine.replace(/\\/g, "/").trim();
    const isFail =
      /\bFAIL\b/.test(line) || // vitest "FAIL  tests/unit/foo.test.ts > ..."
      (line.includes("❯") && /\bfailed\b/.test(line)) || // "❯ tests/unit/foo.test.ts (5 tests | 1 failed)"
      /\b\d+\s+failed\b/.test(line); // generic "1 failed" rows that name a file
    if (!isFail) continue;
    const matches = line.match(FILE_RE);
    if (!matches) continue;
    for (const m of matches) found.add(normalizePath(m));
  }
  return [...found];
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Convert a simple glob to an anchored RegExp. Supports `**` (any chars incl.
 *  `/`), `*` (any chars except `/`), and `?` (one non-`/` char). */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        // consume an immediately-following slash so `**/x` also matches `x`
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

/** True when `file` matches any glob. A glob with no `/` is also matched against
 *  the basename, so `--smoke-exempt 'checkin*.test.ts'` covers
 *  `tests/unit/checkin-x.test.ts`. */
export function matchesAnyGlob(file: string, globs: string[]): boolean {
  const norm = normalizePath(file);
  const base = norm.split("/").pop() ?? norm;
  return globs.some((g) => {
    const gn = normalizePath(g.trim());
    if (!gn) return false;
    const re = globToRegExp(gn);
    if (re.test(norm)) return true;
    if (!gn.includes("/") && re.test(base)) return true;
    return false;
  });
}

export interface SmokeExemptClassification {
  /** Failing test files parsed from the smoke output. */
  failing_files: string[];
  /** Failing files covered by an exempt glob. */
  exempt: string[];
  /** Failing files NOT covered — any of these means: abort. */
  non_exempt: string[];
  /** True only when at least one file failed AND every failing file is exempt.
   *  Requires non-empty globs; an empty glob list can never be "all exempt". */
  all_exempt: boolean;
}

export function classifySmokeFailures(
  smokeOutput: string,
  exemptGlobs: string[],
): SmokeExemptClassification {
  const failing_files = parseFailingTestFiles(smokeOutput);
  if (exemptGlobs.length === 0) {
    return { failing_files, exempt: [], non_exempt: failing_files, all_exempt: false };
  }
  const exempt: string[] = [];
  const non_exempt: string[] = [];
  for (const f of failing_files) {
    (matchesAnyGlob(f, exemptGlobs) ? exempt : non_exempt).push(f);
  }
  return {
    failing_files,
    exempt,
    non_exempt,
    all_exempt: failing_files.length > 0 && non_exempt.length === 0,
  };
}
