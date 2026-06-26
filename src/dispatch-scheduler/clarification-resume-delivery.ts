import type { DispatchDoc } from "./types.js";
import type { SqliteDispatchReactor } from "./sqlite-dispatch-reactor.js";

export type ClarificationResumeDeliveryResult = {
  delivered: boolean;
  state: string;
  agent_query_id: string | null;
  failure_detail: string | null;
  resumed: DispatchDoc;
};

export async function deliverClarificationResume(input: {
  reactor: SqliteDispatchReactor;
  resolveEndpoint: (agentName: string) => Promise<string | null>;
  dispatchPhid: string;
  answer: string;
  actor: string;
  clarificationId?: string;
  instructions?: string | string[] | null;
}): Promise<ClarificationResumeDeliveryResult> {
  const resumed = await input.reactor.resumeAfterClarification(input.dispatchPhid, {
    clarification_id: input.clarificationId,
    actor: input.actor,
    answer: input.answer,
    instructions: input.instructions ?? null,
  });

  let delivered = false;
  let agent_query_id: string | null = null;
  let failureDetail: string | null = null;
  try {
    const endpoint = await input.resolveEndpoint(resumed.to_agent);
    if (!endpoint) {
      failureDetail = `agent "${resumed.to_agent}" not resolvable to endpoint`;
    } else {
      const resumeMessage = [
        `[RESUME for dispatch ${resumed.dispatch_phid}]`,
        `Original subject: ${resumed.subject}`,
        `Your question was answered. Continue the dispatch (do not create new work).`,
        ``,
        `Manager answer: ${input.answer}`,
        input.instructions
          ? `Follow-up instructions: ${Array.isArray(input.instructions) ? input.instructions.map((s) => `- ${s}`).join("\n") : input.instructions}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
      const r = await fetch(`${endpoint}/talk`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: resumeMessage,
          from: input.actor,
          dispatch_id: resumed.dispatch_phid,
          clarification_id: input.clarificationId ?? null,
        }),
      });
      if (!r.ok) {
        failureDetail = `talk delivery returned HTTP ${r.status}`;
      } else {
        try {
          const json = (await r.json()) as { query_id?: string };
          agent_query_id = typeof json?.query_id === "string" ? json.query_id : null;
        } catch {
          agent_query_id = null;
        }
        delivered = true;
      }
    }
  } catch (deliveryErr) {
    failureDetail = deliveryErr instanceof Error ? deliveryErr.message : String(deliveryErr);
  }

  if (delivered) {
    await input.reactor.markResumeDelivered(resumed.dispatch_phid, {
      clarification_id:
        resumed.clarification_history
          .slice()
          .reverse()
          .find((e) => e.type === "RESUME")?.clarification_id ??
        input.clarificationId ??
        "",
      transport: "talk_followup",
      agent_query_id,
    });
    return {
      delivered: true,
      state: "queued",
      agent_query_id,
      failure_detail: null,
      resumed,
    };
  }

  await input.reactor.markResumeDeliveryFailed(resumed.dispatch_phid, {
    clarification_id:
      input.clarificationId ??
      resumed.clarification_history
        .slice()
        .reverse()
        .find((e) => e.type === "RESUME")?.clarification_id ??
      "",
    failure_detail: failureDetail ?? "unknown delivery failure",
  });
  return {
    delivered: false,
    state: "resume_delivery_failed",
    agent_query_id: null,
    failure_detail: failureDetail,
    resumed,
  };
}
