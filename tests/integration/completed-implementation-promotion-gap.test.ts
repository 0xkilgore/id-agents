import fs from "node:fs";

import { describe, expect, it } from "vitest";

import type { AuthoritativeLifecycleInputs } from "../../src/continuous-orchestration/authoritative-lifecycle-reconciler.js";
import {
  projectLifecycleStatus,
  type LifecycleProjectionSource,
} from "../../src/continuous-orchestration/lifecycle-status-projection.js";

interface PromotionGapFixtureCase {
  name: string;
  source: { kind: LifecycleProjectionSource; id: string };
  facts: AuthoritativeLifecycleInputs;
  expected_promotion_state: "missing" | "invalid";
}

interface PromotionGapFixture {
  schema_version: "manager.completed_implementation_promotion_gap.v1";
  owner: string;
  cases: PromotionGapFixtureCase[];
}

const fixture = JSON.parse(
  fs.readFileSync("tests/fixtures/manager/completed-implementation-promotion-gap.json", "utf8"),
) as PromotionGapFixture;

describe("completed implementation promotion-gap reconciliation fixture", () => {
  it.each(fixture.cases)("$name stays non-terminal with one owned promotion action", (entry) => {
    const before = structuredClone(entry);

    const first = projectLifecycleStatus({
      source: entry.source,
      owner: fixture.owner,
      facts: entry.facts,
    });
    const second = projectLifecycleStatus({
      source: entry.source,
      owner: fixture.owner,
      facts: entry.facts,
    });

    expect(fixture.schema_version).toBe("manager.completed_implementation_promotion_gap.v1");
    expect(first).toMatchObject({
      reconciliation: {
        state: "done_unintegrated",
        blocks_dependency_chain: false,
      },
      owner: { id: fixture.owner, assigned: true },
      next_action: {
        kind: "promote",
        reason: "verify and complete required promotion",
      },
      promotion_validation: {
        required: true,
        state: entry.expected_promotion_state,
      },
      read_only: true,
    });

    // Reconciliation is a projection: repeated passes return the same single
    // owned action and cannot enqueue or accumulate follow-on work.
    expect(second).toEqual(first);
    expect(Object.keys(first).filter((key) => key === "next_action")).toHaveLength(1);
    expect(entry).toEqual(before);
  });
});
