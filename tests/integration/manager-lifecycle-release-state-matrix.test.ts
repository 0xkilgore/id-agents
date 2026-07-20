import fs from "node:fs";

import { describe, expect, it } from "vitest";

import {
  reconcileAuthoritativeLifecycleBatchDryRun,
  type AuthoritativeLifecycleInputs,
  type AuthoritativeLifecycleStatus,
} from "../../src/continuous-orchestration/authoritative-lifecycle-reconciler.js";

interface LifecycleFixtureCase {
  name: string;
  expected_status: AuthoritativeLifecycleStatus;
  input: AuthoritativeLifecycleInputs;
}

interface LifecycleFixture {
  schema_version: "manager.lifecycle_release_state_matrix.v1";
  cases: LifecycleFixtureCase[];
}

const fixture = JSON.parse(
  fs.readFileSync("tests/fixtures/manager/lifecycle-release-state-matrix.json", "utf8"),
) as LifecycleFixture;

describe("manager lifecycle release-state black-box matrix", () => {
  it("advances completed work through promotion, fresh deployment, and acceptance", () => {
    const releaseCases = fixture.cases.slice(0, 4);
    const before = structuredClone(releaseCases);
    const result = reconcileAuthoritativeLifecycleBatchDryRun(releaseCases.map((entry) => entry.input));

    expect(fixture.schema_version).toBe("manager.lifecycle_release_state_matrix.v1");
    expect(result.results.map((entry) => entry.status)).toEqual([
      "done_unintegrated",
      "promoted",
      "deployed_fresh",
      "accepted",
    ]);
    expect(result.counts).toMatchObject({
      done_unintegrated: 1,
      promoted: 1,
      deployed_fresh: 1,
      accepted: 1,
    });
    expect(releaseCases).toEqual(before);
    expect(result.mutates).toBe(false);
  });

  it.each(fixture.cases)("$name -> $expected_status", ({ input, expected_status }) => {
    const [result] = reconcileAuthoritativeLifecycleBatchDryRun([input]).results;

    expect(result?.status).toBe(expected_status);
    expect(result?.evidence.length).toBeGreaterThan(0);
  });

  it("keeps superseded and failed_needs_owner terminal outcomes out of the release path", () => {
    const terminalCases = fixture.cases.slice(4);
    const result = reconcileAuthoritativeLifecycleBatchDryRun(terminalCases.map((entry) => entry.input));

    expect(result.results.map((entry) => entry.status)).toEqual(["superseded", "failed_needs_owner"]);
    expect(result.counts).toMatchObject({
      done_unintegrated: 0,
      promoted: 0,
      deployed_fresh: 0,
      accepted: 0,
      superseded: 1,
      failed_needs_owner: 1,
    });
  });
});
