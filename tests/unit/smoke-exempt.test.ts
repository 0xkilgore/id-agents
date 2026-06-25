// T-QA.7 — smoke-exempt classifier: parse failing test files from vitest output
// and decide whether EVERY failure is operator-exempt (so a flaky/unrelated red
// test never aborts an otherwise-clean promotion).

import { describe, it, expect } from "vitest";
import {
  parseFailingTestFiles,
  globToRegExp,
  matchesAnyGlob,
  classifySmokeFailures,
} from "../../src/cli/smoke-exempt.js";

const VITEST_FAIL = `
 RUN  v4.1.4

 ❯ tests/unit/checkin-service-integration.test.ts (5 tests | 1 failed) 1200ms
 ✓ tests/unit/outputs-reactions-feedback.test.ts (9 tests) 152ms

⎯⎯⎯ Failed Tests 1 ⎯⎯⎯

 FAIL  tests/unit/checkin-service-integration.test.ts > CheckinService > flushes
AssertionError: expected 200 to be 503

 Test Files  1 failed | 40 passed (41)
`;

describe("parseFailingTestFiles", () => {
  it("extracts only the failing test file(s), not the passing ones", () => {
    const files = parseFailingTestFiles(VITEST_FAIL);
    expect(files).toContain("tests/unit/checkin-service-integration.test.ts");
    expect(files).not.toContain("tests/unit/outputs-reactions-feedback.test.ts");
  });

  it("dedupes a file that appears on multiple failure lines", () => {
    expect(parseFailingTestFiles(VITEST_FAIL).filter((f) => f.includes("checkin"))).toHaveLength(1);
  });

  it("returns [] when nothing failed", () => {
    expect(parseFailingTestFiles(" ✓ tests/unit/a.test.ts (3 tests)\n Test Files  1 passed (1)")).toEqual([]);
  });

  it("normalizes ./ and backslashes", () => {
    expect(parseFailingTestFiles("FAIL .\\tests\\unit\\x.test.ts > y")).toEqual(["tests/unit/x.test.ts"]);
  });
});

describe("globToRegExp / matchesAnyGlob", () => {
  it("* matches within a path segment but not across /", () => {
    expect(globToRegExp("tests/unit/checkin*.test.ts").test("tests/unit/checkin-x.test.ts")).toBe(true);
    expect(globToRegExp("tests/unit/*.test.ts").test("tests/unit/sub/x.test.ts")).toBe(false);
  });

  it("** matches across / (and **/ also matches zero dirs)", () => {
    expect(globToRegExp("**/checkin*.test.ts").test("tests/unit/checkin-x.test.ts")).toBe(true);
    expect(globToRegExp("**/x.test.ts").test("x.test.ts")).toBe(true);
  });

  it("a slash-less glob also matches the basename", () => {
    expect(matchesAnyGlob("tests/unit/checkin-x.test.ts", ["checkin*.test.ts"])).toBe(true);
    expect(matchesAnyGlob("tests/unit/other.test.ts", ["checkin*.test.ts"])).toBe(false);
  });
});

describe("classifySmokeFailures", () => {
  it("all_exempt=true only when every failing file matches a glob", () => {
    const c = classifySmokeFailures(VITEST_FAIL, ["**/checkin-service-integration.test.ts"]);
    expect(c.failing_files).toHaveLength(1);
    expect(c.exempt).toHaveLength(1);
    expect(c.non_exempt).toHaveLength(0);
    expect(c.all_exempt).toBe(true);
  });

  it("all_exempt=false when a non-exempt file also failed", () => {
    const out = VITEST_FAIL + "\n FAIL  tests/unit/gateway-eval-recommend.test.ts > x\n";
    const c = classifySmokeFailures(out, ["**/checkin-service-integration.test.ts"]);
    expect(c.non_exempt).toContain("tests/unit/gateway-eval-recommend.test.ts");
    expect(c.all_exempt).toBe(false);
  });

  it("empty glob list can never be all_exempt (preserves today's abort behavior)", () => {
    const c = classifySmokeFailures(VITEST_FAIL, []);
    expect(c.all_exempt).toBe(false);
    expect(c.non_exempt).toEqual(c.failing_files);
  });

  it("no failing files parsed → not all_exempt (don't proceed on an unparseable failure)", () => {
    const c = classifySmokeFailures("build error: tsc exploded", ["**/*.test.ts"]);
    expect(c.failing_files).toEqual([]);
    expect(c.all_exempt).toBe(false);
  });
});
