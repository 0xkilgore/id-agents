export type ClarificationActionClass =
  | "no_remote"
  | "divergent_branch"
  | "focused_green_broad_red"
  | "ambiguous_repo";

export interface ClarificationProjectionItem {
  dispatch_id: string;
  subject?: string | null;
  question?: string | null;
  context?: unknown;
  created_at?: string | null;
  age_seconds?: number | null;
}

export interface ClarificationActionClassProjection {
  action_class: ClarificationActionClass;
  count: number;
  oldest_age_seconds: number;
  dispatch_ids: string[];
  recommended_owner: string;
}

export interface ClarificationBatchProjection {
  schema_version: "dispatch_clarification_batches.v1";
  dispatch_id_limit: number;
  action_classes: ClarificationActionClassProjection[];
}

const ACTION_CLASS_ORDER: ClarificationActionClass[] = [
  "no_remote",
  "divergent_branch",
  "focused_green_broad_red",
  "ambiguous_repo",
];

const RECOMMENDED_OWNERS: Record<ClarificationActionClass, string> = {
  no_remote: "release-engineering",
  divergent_branch: "release-engineering",
  focused_green_broad_red: "test-owner",
  ambiguous_repo: "dispatcher",
};

export function buildClarificationBatchProjection(
  items: readonly ClarificationProjectionItem[],
  opts: { dispatchIdLimit?: number } = {},
): ClarificationBatchProjection {
  const dispatchIdLimit = Math.max(1, Math.floor(opts.dispatchIdLimit ?? 10));
  const groups = new Map<ClarificationActionClass, ClarificationProjectionItem[]>();
  for (const item of items) {
    const actionClass = classifyClarificationActionClass(item);
    if (!actionClass) continue;
    const existing = groups.get(actionClass) ?? [];
    existing.push(item);
    groups.set(actionClass, existing);
  }

  return {
    schema_version: "dispatch_clarification_batches.v1",
    dispatch_id_limit: dispatchIdLimit,
    action_classes: ACTION_CLASS_ORDER.map((actionClass) => {
      const grouped = groups.get(actionClass) ?? [];
      const oldestAge = grouped.reduce((oldest, item) => {
        const age = normalizeAgeSeconds(item);
        return Math.max(oldest, age);
      }, 0);
      return {
        action_class: actionClass,
        count: grouped.length,
        oldest_age_seconds: oldestAge,
        dispatch_ids: grouped
          .slice()
          .sort(compareOldestFirst)
          .slice(0, dispatchIdLimit)
          .map((item) => item.dispatch_id),
        recommended_owner: RECOMMENDED_OWNERS[actionClass],
      };
    }),
  };
}

export function classifyClarificationActionClass(
  item: ClarificationProjectionItem,
): ClarificationActionClass | null {
  const text = searchableText(item);

  if (matchesAny(text, [
    "no remote",
    "missing remote",
    "remote not found",
    "remote origin not found",
    "does not have a remote",
    "no configured remote",
    "could not read remote",
    "couldn't read remote",
  ])) {
    return "no_remote";
  }

  if (
    /\bahead\s*=\s*\d+.*\bbehind\s*=\s*\d+/.test(text) ||
    /\bbehind\s*=\s*\d+.*\bahead\s*=\s*\d+/.test(text) ||
    matchesAny(text, [
      "ahead and behind",
      "ahead/behind",
      "branch has diverged",
      "divergent branch",
      "divergent ancestry",
      "divergent promotion",
      "cannot fast-forward",
    ])
  ) {
    return "divergent_branch";
  }

  if (
    (
      matchesAny(text, ["focused test", "focused tests", "targeted test", "targeted tests"]) &&
      matchesAny(text, ["green", "passed", "pass"]) &&
      matchesAny(text, ["broad test", "broad tests", "full test", "full tests", "build", "typecheck", "test suite"]) &&
      matchesAny(text, ["red", "failed", "failing", "failure"])
    ) ||
    matchesAny(text, [
      "focused green broad red",
      "focused tests green but broad tests red",
      "focused tests passed but full test",
      "targeted tests passed but full test",
    ])
  ) {
    return "focused_green_broad_red";
  }

  if (matchesAny(text, [
    "ambiguous repo",
    "which repo",
    "repo ambiguous",
    "repository ambiguous",
    "multiple repos",
    "multiple repositories",
    "missing repo",
    "no repo metadata",
    "repo not specified",
    "repository not specified",
  ])) {
    return "ambiguous_repo";
  }

  return null;
}

function compareOldestFirst(a: ClarificationProjectionItem, b: ClarificationProjectionItem): number {
  return normalizeAgeSeconds(b) - normalizeAgeSeconds(a) ||
    String(a.dispatch_id).localeCompare(String(b.dispatch_id));
}

function normalizeAgeSeconds(item: ClarificationProjectionItem): number {
  if (typeof item.age_seconds === "number" && Number.isFinite(item.age_seconds)) {
    return Math.max(0, Math.floor(item.age_seconds));
  }
  if (item.created_at) {
    const createdMs = Date.parse(item.created_at);
    if (Number.isFinite(createdMs)) {
      return Math.max(0, Math.floor((Date.now() - createdMs) / 1000));
    }
  }
  return 0;
}

function searchableText(item: ClarificationProjectionItem): string {
  return [
    item.dispatch_id,
    item.subject,
    item.question,
    stringifyLoose(item.context),
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n")
    .toLowerCase();
}

function stringifyLoose(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function matchesAny(text: string, needles: readonly string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}
