import { describe, expect, it } from "vitest";
import {
  guardArtifactCreate,
  guardDispatchCreate,
  guardTaskCreate,
} from "../../src/conformance/write-guard.js";

describe("conformance write guard", () => {
  it("rejects create records when required fields are not derivable", () => {
    const task = guardTaskCreate({
      title: "Unowned task",
      description: null,
      track: null,
      owner: null,
      created_by: null,
      team_id: "team_1",
    });

    expect(task.decision).toBe("rejected");
    expect(task.rejected_fields).toEqual(["owner"]);
  });

  it("auto-repairs task metadata from create request context", () => {
    const task = guardTaskCreate({
      title: "Ship bounded guard",
      description: "Context",
      track: null,
      owner: null,
      created_by: "agent_roger",
      owner_name: "roger",
      team_id: "team_1",
    });

    expect(task.decision).toBe("repaired");
    expect(task.repaired_fields).toEqual(expect.arrayContaining(["owner", "track", "next_action"]));
    expect(task.value).toMatchObject({
      owner: "agent_roger",
      track: "T-ORCH",
    });
    expect(task.value.description).toContain('Next action: roger advances "Ship bounded guard".');
  });

  it("repairs dispatch and artifact records without changing their identity fields", () => {
    const dispatch = guardDispatchCreate({
      subject: "Build path",
      body_markdown: "[project: kapelle] implement it",
      team_name: "kapelle",
      to_agent: "roger",
    });
    expect(dispatch.decision).toBe("repaired");
    expect(dispatch.value.subject).toContain("[T-ORCH]");
    expect(dispatch.value.body_markdown).toMatch(/Next action:/);

    const artifact = guardArtifactCreate({
      basename: "closeout.md",
      agent: "roger",
      abs_path: "/Users/kilgore/Dropbox/Code/kapelle/output/closeout.md",
    });
    expect(artifact.decision).toBe("repaired");
    expect(artifact.value).toMatchObject({
      tag: "[T-ORCH]",
      title: "Next action: review closeout.md",
      project_ref: "kapelle",
    });
  });
});
