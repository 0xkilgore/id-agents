import type { TasksRepository } from "../db/db-service.js";
import type { EnqueueInputV2, EnqueueResult } from "../dispatch-scheduler/manager-integration.js";

export interface EmailAliasRow {
  id: string;
  team_id: string;
  user_id: string;
  address: string;
  default_project: string | null;
  default_agent: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmailMessageRow {
  idempotency_key: string;
  team_id: string;
  alias_id: string;
  inbox_phid: string;
  message_id: string | null;
  source_from: string | null;
  source_to: string;
  source_subject: string | null;
  received_at: string;
  triage_action: "task" | "dispatch" | "inbox_only";
  task_id: string | null;
  dispatch_phid: string | null;
  created_at: string;
}

export interface RegisterEmailAliasInput {
  team_id: string;
  user_id: string;
  address: string;
  default_project?: string | null;
  default_agent?: string | null;
  now?: Date;
}

export interface ForwardedEmailInput {
  team_id?: string;
  to: string;
  from?: string | null;
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  message_id?: string | null;
  received_at?: string | null;
}

export interface EmailIntakeOptions {
  tasks?: TasksRepository;
  enqueueDispatch?: (input: EnqueueInputV2, opts?: { wake?: boolean }) => Promise<EnqueueResult>;
  now?: () => Date;
}

export interface EmailIntakeResult {
  ok: true;
  idempotent: boolean;
  alias: EmailAliasRow;
  inbox_phid: string;
  action: "task" | "dispatch" | "inbox_only";
  task_name: string | null;
  dispatch_phid: string | null;
  query_id: string | null;
}
