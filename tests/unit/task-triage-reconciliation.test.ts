import { describe, expect, it } from "vitest";
import {
  buildTaskTriageReview,
  extractTaskNoteSignals,
  taskNoteDispatchMessage,
} from "../../src/task-triage/reconciliation.js";
import type { AgentRow, TaskRow } from "../../src/db/types.js";
import type { TaskNoteEventRow } from "../../src/task-notes/storage.js";

const TASK: TaskRow = {
  id: "task_1",
  name: "personal-term-life",
  uuid: "uuid-task-1",
  team_id: "team_1",
  title: "Personal term-life research",
  description: "Personal agent should refire research on term-life options.\nAsk Chris whether to keep the stale carrier list.",
  status: "todo",
  created_by: null,
  owner: null,
  created_at: 1783450000,
  updated_at: 1783450100,
  completed_at: null,
  track: "(unassigned)",
};

const PERSONAL_AGENT: AgentRow = {
  team_id: "team_1",
  id: "agent_personal",
  name: "personal",
  type: "assistant",
  model: "test",
  port: 0,
  endpoint: null,
  working_directory: null,
  status: "running",
  created_at: 0,
  registry: null,
  metadata: null,
  deleted_at: null,
  runtime: "codex",
  token_id: null,
  domain: null,
  api_key: null,
  customer_domain: null,
  public_endpoint_url: null,
  internal_endpoint_url: null,
  ssh_target: null,
  last_seen: null,
  last_probed_at: null,
  last_error: null,
  consecutive_failures: 0,
};

describe("task triage reconciliation", () => {
  it("extracts stable note signals from manager task descriptions", () => {
    const signals = extractTaskNoteSignals(TASK);
    expect(signals).toHaveLength(2);
    expect(signals[0]).toMatchObject({
      task_ref: "personal-term-life",
      source_surface: "manager_task_description",
      description_line: 1,
    });
    expect(signals[0].item_id).toMatch(/^tasknote_[a-f0-9]{16}$/);
  });

  it("classifies explicit agent-owned notes as deterministic auto-routes", () => {
    const review = buildTaskTriageReview({
      tasks: [TASK],
      agents: [PERSONAL_AGENT],
      nowIso: "2026-07-07T20:00:00.000Z",
    });

    expect(review.source.inbox_digest).toBe("excluded");
    expect(review.summary.task_note_to_action).toBe(1);
    expect(review.summary.needs_chris).toBe(1);
    expect(review.summary.safe_action_candidates).toBe(1);
    expect(review.summary.console_lane_items).toBe(1);

    const route = review.items.find((item) => item.classification === "task_note_to_action");
    expect(route).toMatchObject({
      target_agent: "personal",
      deterministic_safe: true,
      console_lane: "auto_routed",
    });
  });

  it("preserves provenance in dispatch messages", () => {
    const review = buildTaskTriageReview({ tasks: [TASK], agents: [PERSONAL_AGENT] });
    const item = review.items.find((candidate) => candidate.target_agent === "personal")!;
    const message = taskNoteDispatchMessage(item);
    expect(message).toContain("Task note routed by task triage loop.");
    expect(message).toContain("manager_task_description line 1");
    expect(message).toContain('"source_field":"tasks.description"');
  });

  it("includes durable appended task notes in the same reconciliation model", () => {
    const note: TaskNoteEventRow = {
      note_id: "tnote_123",
      team_id: "team_1",
      task_ref: "personal-term-life",
      task_uuid: "uuid-task-1",
      task_name: "personal-term-life",
      source_path: null,
      source_project: null,
      line_number: null,
      actor_ref: "user:chris",
      note_body: "Duplicate of the older row; superseded by the newer review.",
      routing_status: "queued",
      target_agent: null,
      route_error: null,
      dispatch_phid: null,
      query_id: null,
      consumed_by: null,
      consumed_at: null,
      created_at: "2026-07-07T20:00:00.000Z",
      updated_at: "2026-07-07T20:00:00.000Z",
      metadata_json: {},
    };

    const review = buildTaskTriageReview({
      tasks: [{ ...TASK, description: null }],
      agents: [PERSONAL_AGENT],
      taskNotes: [note],
      nowIso: "2026-07-07T20:00:00.000Z",
    });

    expect(review.source.task_notes).toBe(1);
    expect(review.summary.duplicate).toBe(1);
    expect(review.items[0]).toMatchObject({
      item_id: "tnote_123",
      source_surface: "task_note_event",
      classification: "duplicate",
      console_lane: "needs_chris",
    });
  });

  it("does not re-triage completed task descriptions as active notes", () => {
    const review = buildTaskTriageReview({
      tasks: [{ ...TASK, status: "done", completed_at: 1783450200 }],
      agents: [PERSONAL_AGENT],
    });

    expect(review.source.manager_tasks).toBe(1);
    expect(review.source.task_notes).toBe(0);
    expect(review.items).toEqual([]);
  });
});
