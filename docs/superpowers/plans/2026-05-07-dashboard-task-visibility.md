# Dashboard Task Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship one Phase 3 dashboard release that restores truthful Today visibility, adds route-based project task views, upgrades fleet cards from counts to current work, and replaces the broken usage donuts with a snapshot-backed usage surface by 2026-05-15.

**Architecture:** Extend the existing `personal/dashboard` Phase 2 shell instead of rewriting it. Build new read-side projections in `build.py` from the existing `taskview`/`to-do.md`, manager DB, and curation inputs, then consume those projections through additive Next.js routes and components. Keep UI contracts Vetra-compatible by introducing explicit `today_surface`, `projects_index`, `project_surfaces`, and `usage` shapes, but do not block on Prem exposing richer `/agents` fields.

**Tech Stack:** Next.js App Router, React 18, TypeScript, Vitest, Python 3, existing `taskview` parser, launchd snapshot job, static `public/data.json` build flow.

---

**Spec:** `/Users/kilgore/Dropbox/Code/cane/id-agents/docs/superpowers/specs/2026-05-06-dashboard-task-visibility-design.md`

**Build branch:** `dashboard-phase-3-task-visibility`

## File Structure

### New files

| Path | Responsibility |
|------|---------------|
| `/Users/kilgore/Dropbox/Code/personal/dashboard/tests_py/test_build_today_projection.py` | Builder tests for `today_surface`, `projects_index`, and `project_surfaces` |
| `/Users/kilgore/Dropbox/Code/personal/dashboard/app/CanonicalTaskList.tsx` | Reusable canonical task rows for overview and project pages |
| `/Users/kilgore/Dropbox/Code/personal/dashboard/app/__tests__/canonical-task-list.test.tsx` | UI tests for canonical task rendering and mutate actions |
| `/Users/kilgore/Dropbox/Code/personal/dashboard/app/projects/page.tsx` | `/projects` route wrapper using the existing shell |
| `/Users/kilgore/Dropbox/Code/personal/dashboard/app/projects/[slug]/page.tsx` | `/projects/[slug]` route wrapper using the existing shell |
| `/Users/kilgore/Dropbox/Code/personal/dashboard/app/projects/ProjectsIndexView.tsx` | Project index grid with counts and entry points |
| `/Users/kilgore/Dropbox/Code/personal/dashboard/app/projects/ProjectDetailView.tsx` | Project task page with local filter/search and grouped open tasks |
| `/Users/kilgore/Dropbox/Code/personal/dashboard/app/projects/project-utils.ts` | Pure helpers for project lookup, grouping labels, and filtering |
| `/Users/kilgore/Dropbox/Code/personal/dashboard/app/__tests__/project-detail-view.test.tsx` | UI tests for `/projects/[slug]` grouping, filtering, and Obsidian link |
| `/Users/kilgore/Dropbox/Code/personal/dashboard/app/api/agents/projection.ts` | Centralized dashboard-side fleet projection from roster + dispatch/task/news state |
| `/Users/kilgore/Dropbox/Code/personal/dashboard/app/api/agents/__tests__/projection.test.ts` | Unit tests for current-task, waiting-on-human, and check-in fallback projection |
| `/Users/kilgore/Dropbox/Code/personal/dashboard/usage_snapshot.py` | Durable usage snapshot writer for Claude and Codex local session data |
| `/Users/kilgore/Dropbox/Code/personal/dashboard/tests_py/test_usage_snapshot.py` | Snapshot parser/writer tests |
| `/Users/kilgore/Dropbox/Code/personal/dashboard/app/__tests__/page-header-usage-rings.test.tsx` | UI tests for multi-ring usage rendering |
| `/Users/kilgore/Dropbox/Code/personal/dashboard/com.kilgore.dashboard-usage-snapshot.plist` | launchd job that refreshes `usage.json` on the machine with local session access |
| `/Users/kilgore/Dropbox/Code/personal/dashboard/usage.json` | Durable on-disk snapshot consumed by `build.py` and merged into `public/data.json` |

### Modified files

| Path | Change |
|------|--------|
| `/Users/kilgore/Dropbox/Code/personal/dashboard/build.py` | Add additive read-side projections for Today, projects, and usage snapshot merge |
| `/Users/kilgore/Dropbox/Code/personal/dashboard/app/types.ts` | Add `TodaySurface`, `ProjectSurface`, `ProjectsIndexEntry`, and snapshot-backed `UsageData` contracts |
| `/Users/kilgore/Dropbox/Code/personal/dashboard/public/data.demo.json` | Seed demo payload with the new Today/project/fleet/usage shapes |
| `/Users/kilgore/Dropbox/Code/personal/dashboard/app/test/fixtures/dashboard-data.ts` | Keep test fixture aligned with the additive contracts |
| `/Users/kilgore/Dropbox/Code/personal/dashboard/app/Dashboard.tsx` | Replace Focus-only Today with pinned + canonical Today surface and add Projects entry points |
| `/Users/kilgore/Dropbox/Code/personal/dashboard/app/TodayPanel.tsx` | Keep curated priorities as pinned layer and add project route chips |
| `/Users/kilgore/Dropbox/Code/personal/dashboard/app/SearchBar.tsx` | Treat project-task hits as first-class route links and preserve `?demo=true` |
| `/Users/kilgore/Dropbox/Code/personal/dashboard/search.py` | Return project-scoped task results that route into `/projects/[slug]` |
| `/Users/kilgore/Dropbox/Code/personal/dashboard/tests_py/test_search.py` | Verify project-route search results |
| `/Users/kilgore/Dropbox/Code/personal/dashboard/app/__tests__/search-bar.test.tsx` | Verify internal project links render correctly |
| `/Users/kilgore/Dropbox/Code/personal/dashboard/app/LeftNav.tsx` | Add `Projects` to the Phase 2 shell nav without changing the shell layout |
| `/Users/kilgore/Dropbox/Code/personal/dashboard/app/PageHeader.tsx` | Replace donut fetch-first logic with merged snapshot-backed multi-ring usage UI and richer fleet summary |
| `/Users/kilgore/Dropbox/Code/personal/dashboard/app/api/agents/route.ts` | Query news/check-in rows and delegate fleet shaping to `projection.ts` |
| `/Users/kilgore/Dropbox/Code/personal/dashboard/app/agents/AgentsView.tsx` | Show current work title, age, and human-needed state on the detailed agents page |
| `/Users/kilgore/Dropbox/Code/personal/dashboard/app/globals.css` | Add Phase 3 Today/project/fleet/usage styles in-place |

---

## Task 1: Add additive builder projections for Today and project routes

**Files:**
- Create: `/Users/kilgore/Dropbox/Code/personal/dashboard/tests_py/test_build_today_projection.py`
- Modify: `/Users/kilgore/Dropbox/Code/personal/dashboard/build.py`
- Modify: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/types.ts`
- Modify: `/Users/kilgore/Dropbox/Code/personal/dashboard/public/data.demo.json`

- [ ] **Step 1: Write the failing builder tests**

```python
import unittest
from unittest.mock import patch

import build


class BuildTodayProjectionTests(unittest.TestCase):
    def test_build_payload_exposes_today_surface_and_project_surfaces(self) -> None:
        fake_docs = [
            {
                "project": "personal",
                "path": "/Users/kilgore/Dropbox/Code/personal/to-do.md",
                "sections": [
                    {
                        "name": "Open",
                        "tasks": [
                            {"text": "Escalate invoice", "priority": "high", "due": build.date.today()},
                            {"text": "Research lead list", "priority": "low", "due": None},
                        ],
                    }
                ],
            }
        ]
        fake_curation = {
            "today_priorities": [
                {
                    "id": "pin-1",
                    "title": "Close the dashboard gap",
                    "reasoning": "Manager-pinned priority",
                    "project": "personal",
                    "source_path": None,
                    "obsidian_url": None,
                    "artifact_path": None,
                    "artifact_url": None,
                    "artifact_label": None,
                }
            ],
            "triage_queue": [],
            "last_synthesized_at": "2026-05-07T09:00:00-05:00",
            "stale": False,
            "stale_reason": None,
            "refresh_state": {"in_flight": False, "last_trigger": "manual"},
        }

        with patch.object(build.taskview, "load_config", return_value={}), \
             patch.object(build.taskview, "discover_todos", return_value=fake_docs), \
             patch.object(build, "load_curation", return_value=fake_curation):
            payload = build.build_payload()

        self.assertEqual(payload["today_surface"]["pinned"][0]["title"], "Close the dashboard gap")
        self.assertEqual(payload["today_surface"]["due_today"][0]["text"], "Escalate invoice")
        self.assertEqual(payload["projects_index"][0]["slug"], "personal")
        self.assertEqual(
            payload["project_surfaces"]["personal"]["groups"]["unscheduled"][0]["text"],
            "Research lead list",
        )


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/kilgore/Dropbox/Code/personal/dashboard && python3 -m unittest tests_py.test_build_today_projection -v`
Expected: FAIL with `KeyError: 'today_surface'` or `KeyError: 'project_surfaces'` because the payload is still Phase 2 shaped.

- [ ] **Step 3: Implement the additive Today/project projections**

```python
def collect_project_surfaces(palette: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    config = taskview.load_config()
    docs = taskview.discover_todos(config)
    index: list[dict[str, Any]] = []
    surfaces: dict[str, Any] = {}
    today = date.today()
    week_cutoff = today + timedelta(days=(6 - today.weekday()))

    for project_doc in docs:
        slug = project_doc["project"]
        path = project_doc.get("path")
        source_path = str(Path(path).resolve()) if path else None
        groups = {"overdue": [], "today": [], "this_week": [], "later": [], "unscheduled": []}

        for section_idx, section in enumerate(project_doc["sections"]):
            if section["name"].lower() in taskview.COMPLETED_SECTIONS:
                continue
            for task_idx, task in enumerate(section["tasks"]):
                if task.get("done"):
                    continue
                due = task.get("due")
                item = {
                    "id": f"{slug}::{section_idx}::{task_idx}",
                    "project": slug,
                    "project_slug": slug,
                    "project_path": path,
                    "source_path": source_path,
                    "obsidian_url": obsidian_url_for(source_path),
                    "color": color_for(palette, slug),
                    "text": task["text"],
                    "priority": task.get("priority"),
                    "owner": task.get("owner"),
                    "due": due.isoformat() if due else None,
                    "note": task.get("note"),
                    "detail": task.get("detail"),
                    "snoozed": task.get("snoozed").isoformat() if task.get("snoozed") else None,
                }
                if due is None:
                    groups["unscheduled"].append(item)
                elif due < today:
                    item["days_overdue"] = (today - due).days
                    groups["overdue"].append(item)
                elif due == today:
                    groups["today"].append(item)
                elif due <= week_cutoff:
                    item["days_until"] = (due - today).days
                    groups["this_week"].append(item)
                else:
                    item["days_until"] = (due - today).days
                    groups["later"].append(item)

        total_open = sum(len(items) for items in groups.values())
        index.append({
            "slug": slug,
            "name": slug,
            "color": color_for(palette, slug),
            "open_count": total_open,
            "overdue_count": len(groups["overdue"]),
            "today_count": len(groups["today"]),
            "source_path": source_path,
            "obsidian_url": obsidian_url_for(source_path),
        })
        surfaces[slug] = {
            "slug": slug,
            "name": slug,
            "source_path": source_path,
            "obsidian_url": obsidian_url_for(source_path),
            "groups": groups,
        }

    index.sort(key=lambda entry: (-entry["open_count"], entry["slug"]))
    return index, surfaces


def collect_today_surface(curation: dict[str, Any], todos: dict[str, Any]) -> dict[str, Any]:
    return {
        "pinned": curation.get("today_priorities", []),
        "overdue_high": todos["overdue_high"],
        "due_today": todos["due_today"],
        "due_this_week": todos["due_this_week"],
        "last_built_at": now_iso(),
    }


def build_payload() -> dict[str, Any]:
    _init_obsidian_symlinks()
    palette = load_palette()
    todos = collect_todos(palette)
    curation = load_curation()
    projects_index, project_surfaces = collect_project_surfaces(palette)
    return {
        "generated_at": now_iso(),
        "palette": palette,
        "todos": todos,
        "today_surface": collect_today_surface(curation, todos),
        "projects_index": projects_index,
        "project_surfaces": project_surfaces,
        "inbox": collect_inbox(palette),
        "sentinel": collect_sentinel(),
        "agents": collect_agents(palette),
        "scheduled": collect_scheduled(),
        "projects": collect_projects(palette),
        "completions": collect_completions_feed(palette),
        "waiting_on": collect_waiting_on(),
        "curation": curation,
    }
```

Append to `/Users/kilgore/Dropbox/Code/personal/dashboard/app/types.ts`:

```typescript
export type ProjectTask = {
  id: string;
  project: string;
  project_slug: string;
  project_path?: string | null;
  source_path?: string | null;
  obsidian_url?: string | null;
  color?: string | null;
  text: string;
  priority: "high" | "med" | "low" | null;
  owner?: string | null;
  due: string | null;
  note?: string | null;
  detail?: string | null;
  snoozed?: string | null;
  days_overdue?: number;
  days_until?: number;
};

export type TodaySurface = {
  pinned: CuratedPriority[];
  overdue_high: ProjectTask[];
  due_today: ProjectTask[];
  due_this_week: ProjectTask[];
  last_built_at: string;
};

export type ProjectsIndexEntry = {
  slug: string;
  name: string;
  color?: string | null;
  open_count: number;
  overdue_count: number;
  today_count: number;
  source_path?: string | null;
  obsidian_url?: string | null;
};

export type ProjectSurface = {
  slug: string;
  name: string;
  source_path?: string | null;
  obsidian_url?: string | null;
  groups: Record<"overdue" | "today" | "this_week" | "later" | "unscheduled", ProjectTask[]>;
};

export type Data = {
  generated_at: string;
  palette?: Palette;
  todos: {
    due_today: Todo[];
    overdue_high: Todo[];
    overdue_med_low: Todo[];
    due_this_week: Todo[];
  };
  today_surface: TodaySurface;
  projects_index: ProjectsIndexEntry[];
  project_surfaces: Record<string, ProjectSurface>;
  inbox: {
    unprocessed: InboxEntry[];
    processed: InboxEntry[];
  };
  sentinel: Sentinel;
  agents: Agent[];
  agents_progress?: AgentProgress[];
  scheduled: Scheduled[];
  projects: ProjectSummary[];
  completions: FeedEntry[];
  waiting_on: WaitingOn[];
  curation: Curation;
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/kilgore/Dropbox/Code/personal/dashboard && python3 -m unittest tests_py.test_build_today_projection -v`
Expected: PASS with `test_build_payload_exposes_today_surface_and_project_surfaces ... ok`

- [ ] **Step 5: Commit**

```bash
cd /Users/kilgore/Dropbox/Code/personal/dashboard
git add build.py app/types.ts public/data.demo.json tests_py/test_build_today_projection.py
git commit -m "Add dashboard today and project projections"
```

---

## Task 2: Restore truthful Today visibility on the overview

**Files:**
- Create: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/CanonicalTaskList.tsx`
- Create: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/__tests__/canonical-task-list.test.tsx`
- Modify: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/Dashboard.tsx`
- Modify: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/TodayPanel.tsx`
- Modify: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/globals.css`
- Modify: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/test/fixtures/dashboard-data.ts`

- [ ] **Step 1: Write the failing UI test**

```tsx
import { render, screen } from "@testing-library/react";
import CanonicalTaskList from "../CanonicalTaskList";

test("renders canonical tasks even when no curated priorities are pinned", () => {
  render(
    <CanonicalTaskList
      surface={{
        pinned: [],
        overdue_high: [],
        due_today: [
          {
            id: "personal::0::0",
            project: "personal",
            project_slug: "personal",
            text: "Reach out to Walker",
            priority: "high",
            due: "2026-05-07",
            color: "#2563eb",
          },
        ],
        due_this_week: [],
        last_built_at: "2026-05-07T09:30:00-05:00",
      }}
      setToast={vi.fn()}
      onMutated={vi.fn(async () => {})}
      showPinnedEmptyNote
    />
  );

  expect(screen.getByText("No curated priorities pinned. Showing canonical tasks.")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "personal" })).toHaveAttribute("href", "/projects/personal");
  expect(screen.getByText("Reach out to Walker")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/kilgore/Dropbox/Code/personal/dashboard && npm test -- app/__tests__/canonical-task-list.test.tsx`
Expected: FAIL with `Cannot find module '../CanonicalTaskList'` or missing text/link assertions.

- [ ] **Step 3: Implement the Today surface UI**

Create `/Users/kilgore/Dropbox/Code/personal/dashboard/app/CanonicalTaskList.tsx`:

```tsx
"use client";

import Link from "next/link";
import type { ProjectTask, TodaySurface } from "./types";

function TaskGroup({
  label,
  items,
  setToast,
  onMutated,
}: {
  label: string;
  items: ProjectTask[];
  setToast: (toast: { text: string; variant?: "ok" | "err" } | null) => void;
  onMutated: () => Promise<void>;
}) {
  if (items.length === 0) return null;
  return (
    <section className="task-group">
      <div className="task-group-label">{label}</div>
      {items.map((item) => (
        <article key={item.id} className="canonical-task-row">
          <Link href={`/projects/${item.project_slug}`} className="project-chip">
            {item.project}
          </Link>
          <div className="canonical-task-copy">
            <strong>{item.text}</strong>
            <span className="task-meta">
              {item.priority ? `Priority: ${item.priority}` : "Priority: none"}
              {item.due ? ` · Due ${item.due}` : " · Unscheduled"}
            </span>
          </div>
          <div className="canonical-task-actions">
            <button
              type="button"
              className="btn btn-check"
              onClick={async () => {
                await fetch("/api/mutate/todo", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: "done", project: item.project, task: item.text }),
                });
                setToast({ text: "Done.", variant: "ok" });
                await onMutated();
              }}
            >
              Done
            </button>
            <button
              type="button"
              className="btn"
              onClick={async () => {
                await fetch("/api/mutate/todo", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: "snooze", project: item.project, task: item.text, until: "tomorrow" }),
                });
                setToast({ text: "Snoozed.", variant: "ok" });
                await onMutated();
              }}
            >
              Snooze
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}

export default function CanonicalTaskList({
  surface,
  setToast,
  onMutated,
  showPinnedEmptyNote = false,
}: {
  surface: TodaySurface;
  setToast: (toast: { text: string; variant?: "ok" | "err" } | null) => void;
  onMutated: () => Promise<void>;
  showPinnedEmptyNote?: boolean;
}) {
  const hasCanonical =
    surface.overdue_high.length > 0 ||
    surface.due_today.length > 0 ||
    surface.due_this_week.length > 0;

  if (!hasCanonical) {
    return <div className="empty">Nothing due today or this week.</div>;
  }

  return (
    <div className="canonical-task-list">
      {showPinnedEmptyNote && surface.pinned.length === 0 && (
        <div className="subtle-note">No curated priorities pinned. Showing canonical tasks.</div>
      )}
      <TaskGroup label="Overdue high priority" items={surface.overdue_high} setToast={setToast} onMutated={onMutated} />
      <TaskGroup label="Due today" items={surface.due_today} setToast={setToast} onMutated={onMutated} />
      <TaskGroup label="Due this week" items={surface.due_this_week} setToast={setToast} onMutated={onMutated} />
    </div>
  );
}
```

Modify `/Users/kilgore/Dropbox/Code/personal/dashboard/app/Dashboard.tsx`:

```tsx
import CanonicalTaskList from "./CanonicalTaskList";

<section id="focus" className="tile tile-focus">
  <header className="tile-head">
    <span className="tile-label">Today</span>
    <span className="tile-spacer" />
    <span className="page-updated">
      Built {timeAgo(data.today_surface.last_built_at)}
    </span>
  </header>
  <div className="tile-body focus-body">
    <TodayPanel
      items={data.today_surface.pinned}
      lastSynthesizedAt={data.curation.last_synthesized_at}
      stale={data.curation.stale}
      setToast={setToast}
      onMutated={refresh}
      embedded
    />
    <CanonicalTaskList
      surface={data.today_surface}
      setToast={setToast}
      onMutated={refresh}
      showPinnedEmptyNote
    />
    <div className="focus-divider">
      <span>Triage — decide on these</span>
    </div>
    <TriagePanel
      items={data.curation.triage_queue}
      setToast={setToast}
      onMutated={refresh}
      embedded
    />
  </div>
</section>
```

Modify `/Users/kilgore/Dropbox/Code/personal/dashboard/app/TodayPanel.tsx` inside `TodayCard`:

```tsx
import Link from "next/link";

{item.project && (
  <Link
    href={`/projects/${item.project}`}
    className="project-chip"
    onClick={(e) => e.stopPropagation()}
  >
    {item.project}
  </Link>
)}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/kilgore/Dropbox/Code/personal/dashboard && npm test -- app/__tests__/canonical-task-list.test.tsx app/__tests__/today-panel.test.tsx`
Expected: PASS with both Today canonical and pinned tests green.

- [ ] **Step 5: Commit**

```bash
cd /Users/kilgore/Dropbox/Code/personal/dashboard
git add app/CanonicalTaskList.tsx app/__tests__/canonical-task-list.test.tsx app/Dashboard.tsx app/TodayPanel.tsx app/globals.css app/test/fixtures/dashboard-data.ts
git commit -m "Restore canonical today visibility on overview"
```

---

## Task 3: Add route-based project task views and overview entry points

**Files:**
- Create: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/projects/page.tsx`
- Create: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/projects/[slug]/page.tsx`
- Create: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/projects/ProjectsIndexView.tsx`
- Create: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/projects/ProjectDetailView.tsx`
- Create: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/projects/project-utils.ts`
- Create: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/__tests__/project-detail-view.test.tsx`
- Modify: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/LeftNav.tsx`
- Modify: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/Dashboard.tsx`
- Modify: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/globals.css`

- [ ] **Step 1: Write the failing project-page test**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProjectDetailView from "../projects/ProjectDetailView";

test("filters a project page without losing grouped tasks", async () => {
  const user = userEvent.setup();
  render(
    <ProjectDetailView
      surface={{
        slug: "personal",
        name: "personal",
        source_path: "/Users/kilgore/Dropbox/Code/personal/to-do.md",
        obsidian_url: "obsidian://open?path=%2FUsers%2Fkilgore%2FDropbox%2FCode%2Fpersonal%2Fto-do.md",
        groups: {
          overdue: [],
          today: [{ id: "1", project: "personal", project_slug: "personal", text: "Reach out to Walker", priority: "high", due: "2026-05-07" }],
          this_week: [{ id: "2", project: "personal", project_slug: "personal", text: "Book Trinity prep", priority: "med", due: "2026-05-09" }],
          later: [],
          unscheduled: [],
        },
      }}
      setToast={vi.fn()}
      onMutated={vi.fn(async () => {})}
    />
  );

  await user.type(screen.getByPlaceholderText("Filter this project…"), "Walker");
  expect(screen.getByText("Reach out to Walker")).toBeInTheDocument();
  expect(screen.queryByText("Book Trinity prep")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Open to-do.md in Obsidian" })).toHaveAttribute(
    "href",
    "obsidian://open?path=%2FUsers%2Fkilgore%2FDropbox%2FCode%2Fpersonal%2Fto-do.md"
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/kilgore/Dropbox/Code/personal/dashboard && npm test -- app/__tests__/project-detail-view.test.tsx`
Expected: FAIL with `Cannot find module '../projects/ProjectDetailView'`.

- [ ] **Step 3: Implement `/projects` and `/projects/[slug]`**

Create `/Users/kilgore/Dropbox/Code/personal/dashboard/app/projects/page.tsx`:

```tsx
import data from "../../public/data.json";
import { DataProvider } from "../DataProvider";
import PageHeader, { Toast } from "../PageHeader";
import ProjectsIndexView from "./ProjectsIndexView";
import type { Data } from "../types";

export const dynamic = "force-static";

export default function ProjectsPage() {
  return (
    <DataProvider initial={data as unknown as Data}>
      <div className="page">
        <PageHeader title="Projects" />
        <ProjectsIndexView />
        <Toast />
      </div>
    </DataProvider>
  );
}
```

Create `/Users/kilgore/Dropbox/Code/personal/dashboard/app/projects/[slug]/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import data from "../../../public/data.json";
import { DataProvider } from "../../DataProvider";
import PageHeader, { Toast } from "../../PageHeader";
import ProjectDetailView from "../ProjectDetailView";
import type { Data } from "../../types";

export const dynamic = "force-static";

export default function ProjectPage({ params }: { params: { slug: string } }) {
  const typed = data as unknown as Data;
  const surface = typed.project_surfaces?.[params.slug];
  if (!surface) notFound();

  return (
    <DataProvider initial={typed}>
      <div className="page">
        <PageHeader title={surface.name} />
        <ProjectDetailView surface={surface} />
        <Toast />
      </div>
    </DataProvider>
  );
}
```

Create `/Users/kilgore/Dropbox/Code/personal/dashboard/app/projects/ProjectDetailView.tsx`:

```tsx
"use client";

import { useState } from "react";
import Link from "next/link";
import type { ProjectSurface, ProjectTask } from "../types";

export default function ProjectDetailView({
  surface,
  setToast = () => {},
  onMutated = async () => {},
}: {
  surface: ProjectSurface;
  setToast?: (toast: { text: string; variant?: "ok" | "err" } | null) => void;
  onMutated?: () => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const groupOrder: (keyof ProjectSurface["groups"])[] = ["overdue", "today", "this_week", "later", "unscheduled"];
  const groupLabels: Record<keyof ProjectSurface["groups"], string> = {
    overdue: "Overdue",
    today: "Today",
    this_week: "This week",
    later: "Later",
    unscheduled: "Unscheduled",
  };
  const matches = (task: ProjectTask) =>
    !query || task.text.toLowerCase().includes(query.toLowerCase());

  return (
    <div className="page-body project-detail">
      <div className="project-detail-head">
        <input
          type="search"
          placeholder="Filter this project…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {surface.obsidian_url && (
          <Link href={surface.obsidian_url} className="btn">
            Open to-do.md in Obsidian
          </Link>
        )}
      </div>
      {groupOrder.map((group) => {
        const items = surface.groups[group].filter(matches);
        if (items.length === 0) return null;
        return (
          <section key={group} className="task-group">
            <div className="task-group-label">{groupLabels[group]}</div>
            {items.map((item) => (
              <article key={item.id} className="canonical-task-row">
                <div className="canonical-task-copy">
                  <strong>{item.text}</strong>
                  <span className="task-meta">
                    {item.priority ? `Priority: ${item.priority}` : "Priority: none"}
                    {item.due ? ` · Due ${item.due}` : " · Unscheduled"}
                  </span>
                </div>
                <div className="canonical-task-actions">
                  <button
                    type="button"
                    className="btn btn-check"
                    onClick={async () => {
                      await fetch("/api/mutate/todo", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ action: "done", project: item.project, task: item.text }),
                      });
                      setToast({ text: "Done.", variant: "ok" });
                      await onMutated();
                    }}
                  >
                    Done
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={async () => {
                      await fetch("/api/mutate/todo", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ action: "kill", project: item.project, task: item.text }),
                      });
                      setToast({ text: "Killed.", variant: "ok" });
                      await onMutated();
                    }}
                  >
                    Kill
                  </button>
                </div>
              </article>
            ))}
          </section>
        );
      })}
    </div>
  );
}
```

Create `/Users/kilgore/Dropbox/Code/personal/dashboard/app/projects/ProjectsIndexView.tsx`:

```tsx
"use client";

import Link from "next/link";
import { useData } from "../DataProvider";

export default function ProjectsIndexView() {
  const { data } = useData();
  return (
    <div className="page-body project-index-grid">
      {data.projects_index.map((project) => (
        <Link key={project.slug} href={`/projects/${project.slug}`} className="project-index-card">
          <strong>{project.name}</strong>
          <span>{project.open_count} open</span>
          <span>{project.overdue_count} overdue · {project.today_count} today</span>
        </Link>
      ))}
    </div>
  );
}
```

Create `/Users/kilgore/Dropbox/Code/personal/dashboard/app/projects/project-utils.ts`:

```ts
import type { ProjectSurface } from "../types";

export const PROJECT_GROUP_ORDER: (keyof ProjectSurface["groups"])[] = [
  "overdue",
  "today",
  "this_week",
  "later",
  "unscheduled",
];

export const PROJECT_GROUP_LABELS: Record<keyof ProjectSurface["groups"], string> = {
  overdue: "Overdue",
  today: "Today",
  this_week: "This week",
  later: "Later",
  unscheduled: "Unscheduled",
};
```

Modify `/Users/kilgore/Dropbox/Code/personal/dashboard/app/LeftNav.tsx`:

```tsx
function IconFolder() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z" />
    </svg>
  );
}

const ITEMS: NavItem[] = [
  { href: "/", label: "Overview", icon: <IconGrid /> },
  { href: "/projects", label: "Projects", icon: <IconFolder /> },
  { href: "/agents", label: "Agents", icon: <IconCpu /> },
  { href: "/dispatches", label: "Dispatches", icon: <IconSend /> },
  { href: "/inbox", label: "Inbox", icon: <IconInbox /> },
  { href: "/calendar", label: "Calendar", icon: <IconCal /> },
  { href: "/vault", label: "Vault", icon: <IconArchive /> },
];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/kilgore/Dropbox/Code/personal/dashboard && npm test -- app/__tests__/project-detail-view.test.tsx`
Expected: PASS with the filter and Obsidian-link assertions green.

- [ ] **Step 5: Commit**

```bash
cd /Users/kilgore/Dropbox/Code/personal/dashboard
git add app/projects/page.tsx app/projects/[slug]/page.tsx app/projects/ProjectsIndexView.tsx app/projects/ProjectDetailView.tsx app/projects/project-utils.ts app/__tests__/project-detail-view.test.tsx app/LeftNav.tsx app/Dashboard.tsx app/globals.css
git commit -m "Add route-based dashboard project views"
```

---

## Task 4: Extend cross-project search to route into project pages

**Files:**
- Modify: `/Users/kilgore/Dropbox/Code/personal/dashboard/search.py`
- Modify: `/Users/kilgore/Dropbox/Code/personal/dashboard/tests_py/test_search.py`
- Modify: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/SearchBar.tsx`
- Modify: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/__tests__/search-bar.test.tsx`

- [ ] **Step 1: Write the failing search tests**

Append to `/Users/kilgore/Dropbox/Code/personal/dashboard/tests_py/test_search.py`:

```python
    def test_todo_results_link_to_project_routes(self) -> None:
        rows = [
            {
                "path": "/Users/kilgore/Dropbox/Code/personal/to-do.md",
                "line_number": 12,
                "snippet": "- [ ] Reach out to Walker",
            }
        ]
        results = search.todo_results(rows, query="Walker")
        self.assertEqual(results[0]["source"], "personal")
        self.assertEqual(results[0]["link"], "/projects/personal?q=Walker")
```

Append to `/Users/kilgore/Dropbox/Code/personal/dashboard/app/__tests__/search-bar.test.tsx`:

```tsx
test("renders project-route search hits as internal links", async () => {
  const user = userEvent.setup();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              source: "personal",
              snippet: "Reach out to Walker",
              date: null,
              link: "/projects/personal?q=Walker",
            },
          ],
          total: 1,
        }),
        { status: 200 }
      )
    )
  );
  render(<SearchBar />);
  await user.type(screen.getByPlaceholderText("Search to-dos, dispatches, artifacts…"), "Walker{enter}");
  await waitFor(() =>
    expect(screen.getByRole("link", { name: /Reach out to Walker/i })).toHaveAttribute(
      "href",
      "/projects/personal?q=Walker"
    )
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/kilgore/Dropbox/Code/personal/dashboard && python3 -m unittest tests_py.test_search -v && npm test -- app/__tests__/search-bar.test.tsx`
Expected: FAIL because `todo_results()` does not exist and the client still assumes opaque external links.

- [ ] **Step 3: Implement project-aware search results**

Modify `/Users/kilgore/Dropbox/Code/personal/dashboard/search.py`:

```python
from urllib.parse import quote


def todo_results(rows: list[dict[str, Any]], query: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in rows:
        path = Path(row["path"])
        slug = path.parent.name
        out.append({
            "source": slug,
            "snippet": row["snippet"],
            "date": None,
            "link": f"/projects/{slug}?q={quote(query)}",
        })
    return out


def main() -> int:
    query = " ".join(sys.argv[1:]).strip()
    if not query:
        print(json.dumps({"results": [], "total": 0}))
        return 0
    results: list[dict[str, Any]] = []
    results.extend(todo_results(rg_json(query, TODO_GLOB), query))
    results.extend(search_dispatches(query))
    delivery_paths = [str(DELIVERY_LOG)] if DELIVERY_LOG.exists() else []
    artifact_paths = [*delivery_paths, SENTINEL_GLOB]
    if artifact_paths:
        results.extend(
            {"source": "artifact", "snippet": row["snippet"], "date": None, "link": row["path"]}
            for row in rg_json(query, *artifact_paths)
        )
    trimmed = results[:MAX_RESULTS]
    print(json.dumps({"results": trimmed, "total": len(results)}))
    return 0
```

Modify `/Users/kilgore/Dropbox/Code/personal/dashboard/app/SearchBar.tsx`:

```tsx
import Link from "next/link";
import { useSearchParams } from "next/navigation";

const params = useSearchParams();
const demoSuffix = params.get("demo") === "true" ? "?demo=true" : "";

{results.map((result, idx) => {
  const href = result.link.startsWith("/projects/")
    ? `${result.link}${demoSuffix && !result.link.includes("?") ? demoSuffix : demoSuffix.replace("?", "&")}`
    : result.link;
  return (
    <Link
      key={`${result.link}-${idx}`}
      href={href}
      className="search-result"
    >
      <span className="badge muted">{result.source}</span>
      <span>{result.snippet}</span>
    </Link>
  );
})}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/kilgore/Dropbox/Code/personal/dashboard && python3 -m unittest tests_py.test_search -v && npm test -- app/__tests__/search-bar.test.tsx`
Expected: PASS with `test_todo_results_link_to_project_routes ... ok` and the project-route link assertion green.

- [ ] **Step 5: Commit**

```bash
cd /Users/kilgore/Dropbox/Code/personal/dashboard
git add search.py tests_py/test_search.py app/SearchBar.tsx app/__tests__/search-bar.test.tsx
git commit -m "Route dashboard search into project task views"
```

---

## Task 5: Upgrade fleet visibility from counts to current work

**Files:**
- Create: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/api/agents/projection.ts`
- Create: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/api/agents/__tests__/projection.test.ts`
- Modify: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/api/agents/route.ts`
- Modify: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/types.ts`
- Modify: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/PageHeader.tsx`
- Modify: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/Dashboard.tsx`
- Modify: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/agents/AgentsView.tsx`
- Modify: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/globals.css`

- [ ] **Step 1: Write the failing projection test**

```ts
import { buildAgentsProgress } from "../projection";

test("prefers active dispatch title and falls back to latest check-in summary", () => {
  const agents = buildAgentsProgress(
    [{ name: "roger", port: 4137, status: "running" }],
    {
      dispatches: [
        { id: "d1", agent: "roger", title: "Build project routes", status: "in_progress", created_at: "2026-05-07T10:00:00-05:00", started_at: "2026-05-07T10:05:00-05:00", completed_at: null },
      ],
      tasks: [{ name: "build-project-routes", status: "doing", claimed_by: "roger", created_at: "2026-05-07T10:00:00-05:00", completed_at: null }],
      news: [
        { agent: "roger", timestamp: 1778166300000, type: "query.completed", message: "Needs review on project routes" },
      ],
    },
    new Map([["roger", "online"]])
  );

  expect(agents[0].current_task_title).toBe("Build project routes");
  expect(agents[0].current_task_started_at).toBe("2026-05-07T10:05:00-05:00");
  expect(agents[0].waiting_on_human).toBe(true);
  expect(agents[0].latest_checkin_summary).toContain("Needs review");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/kilgore/Dropbox/Code/personal/dashboard && npm test -- app/api/agents/__tests__/projection.test.ts`
Expected: FAIL with `Cannot find module '../projection'`.

- [ ] **Step 3: Implement centralized fleet projection**

Create `/Users/kilgore/Dropbox/Code/personal/dashboard/app/api/agents/projection.ts`:

```ts
type DbBundle = {
  dispatches: { id: string; agent: string; title: string; status: string; created_at: string; started_at: string | null; completed_at: string | null }[];
  tasks: { name: string; status: string; claimed_by: string | null; created_at: string; completed_at: string | null }[];
  news: { agent: string; timestamp: number; type: string; message: string }[];
};

export function buildAgentsProgress(
  roster: { name: string; color?: string | null }[],
  dbData: DbBundle,
  healthMap: Map<string, string>
) {
  return roster.map((agent) => {
    const dispatches = dbData.dispatches.filter((row) => row.agent === agent.name);
    const tasks = dbData.tasks.filter((row) => row.claimed_by === agent.name);
    const news = dbData.news.filter((row) => row.agent === agent.name);
    const currentDispatch = dispatches.find((row) => row.status === "in_progress" || row.status === "processing");
    const latestCheckin = news[0] || null;
    const waitingOnHuman = Boolean(
      dispatches.some((row) => row.status === "blocked") ||
      news.some((row) => /needs review|needs approval|waiting on human/i.test(row.message))
    );
    const state =
      waitingOnHuman ? "waiting" :
      currentDispatch ? "working" :
      healthMap.get(agent.name) === "online" ? "idle" : "stale";

    return {
      name: agent.name,
      color: agent.color || null,
      state,
      tasks_completed_this_week: tasks.filter((row) => row.status === "done").length,
      tasks_assigned_this_week: tasks.length,
      last_active: currentDispatch?.started_at || currentDispatch?.created_at || null,
      current_dispatch: currentDispatch?.title || null,
      current_task_title: currentDispatch?.title || latestCheckin?.message || null,
      current_task_started_at: currentDispatch?.started_at || currentDispatch?.created_at || null,
      waiting_on_human: waitingOnHuman,
      latest_checkin_summary: latestCheckin?.message || null,
      avg_task_hours: null,
      tasks_this_week_total: tasks.length,
    };
  });
}
```

Modify `/Users/kilgore/Dropbox/Code/personal/dashboard/app/api/agents/route.ts`:

```ts
import { buildAgentsProgress } from "./projection";

type NewsRow = {
  agent: string;
  timestamp: number;
  type: string;
  message: string;
};

// inside queryDb()
let news: NewsRow[] = [];
try {
  news = db
    .prepare(
      `SELECT a.name AS agent, ni.timestamp, ni.type, COALESCE(ni.message, '') AS message
       FROM news_items ni
       JOIN agents a ON a.id = ni.agent_id
       WHERE ni.timestamp > (strftime('%s','now','-2 days') * 1000)
       ORDER BY ni.timestamp DESC
       LIMIT 200`
    )
    .all() as NewsRow[];
} catch {
  // Table might not exist
}

return { dispatches, tasks, scheduleRuns, news };

// inside GET()
const agentsProgress = buildAgentsProgress(roster, {
  dispatches: dbData?.dispatches || [],
  tasks: dbData?.tasks || [],
  news: dbData?.news || [],
}, healthMap);
```

Append to `/Users/kilgore/Dropbox/Code/personal/dashboard/app/types.ts`:

```typescript
export type AgentProgress = {
  name: string;
  color?: string | null;
  state: "idle" | "working" | "blocked" | "waiting" | "stale" | string;
  tasks_completed_this_week: number;
  tasks_assigned_this_week: number;
  last_active: string | null;
  current_dispatch: string | null;
  current_task_title?: string | null;
  current_task_started_at?: string | null;
  waiting_on_human?: boolean;
  latest_checkin_summary?: string | null;
  avg_task_hours: number | null;
  tasks_this_week_total: number;
  dispatch_history?: Dispatch[];
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/kilgore/Dropbox/Code/personal/dashboard && npm test -- app/api/agents/__tests__/projection.test.ts`
Expected: PASS with the current-task, start-time, and waiting-on-human assertions green.

- [ ] **Step 5: Commit**

```bash
cd /Users/kilgore/Dropbox/Code/personal/dashboard
git add app/api/agents/projection.ts app/api/agents/__tests__/projection.test.ts app/api/agents/route.ts app/types.ts app/PageHeader.tsx app/Dashboard.tsx app/agents/AgentsView.tsx app/globals.css
git commit -m "Upgrade dashboard fleet cards to current work visibility"
```

---

## Task 6: Replace prod-broken donuts with snapshot-backed usage rings

**Files:**
- Create: `/Users/kilgore/Dropbox/Code/personal/dashboard/usage_snapshot.py`
- Create: `/Users/kilgore/Dropbox/Code/personal/dashboard/tests_py/test_usage_snapshot.py`
- Create: `/Users/kilgore/Dropbox/Code/personal/dashboard/usage.json`
- Create: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/__tests__/page-header-usage-rings.test.tsx`
- Create: `/Users/kilgore/Dropbox/Code/personal/dashboard/com.kilgore.dashboard-usage-snapshot.plist`
- Modify: `/Users/kilgore/Dropbox/Code/personal/dashboard/build.py`
- Modify: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/types.ts`
- Modify: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/PageHeader.tsx`
- Modify: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/globals.css`
- Modify: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/test/fixtures/dashboard-data.ts`
- Modify: `/Users/kilgore/Dropbox/Code/personal/dashboard/public/data.demo.json`

- [ ] **Step 1: Write the failing snapshot and UI tests**

Create `/Users/kilgore/Dropbox/Code/personal/dashboard/tests_py/test_usage_snapshot.py`:

```python
import tempfile
import unittest
from pathlib import Path

import usage_snapshot


class UsageSnapshotTests(unittest.TestCase):
    def test_build_snapshot_returns_phase3_usage_shape(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".claude" / "projects" / "demo").mkdir(parents=True)
            payload = usage_snapshot.empty_snapshot()
            self.assertEqual(sorted(payload["claude"].keys()), ["day", "week", "window_5h"])
            self.assertEqual(sorted(payload["codex"].keys()), ["day", "week"])


if __name__ == "__main__":
    unittest.main()
```

Create `/Users/kilgore/Dropbox/Code/personal/dashboard/app/__tests__/page-header-usage-rings.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { vi } from "vitest";
import PageHeader from "../PageHeader";

vi.mock("../DataProvider", () => ({
  useData: () => ({
    data: {
      generated_at: "2026-05-07T09:30:00-05:00",
      usage: {
        source: "local-snapshot",
        claude: {
          window_5h: { used: 320000, budget: 500000, resets_at: "2026-05-07T14:00:00-05:00" },
          day: { used: 480000, budget: 1000000, resets_at: "2026-05-08T00:00:00-05:00" },
          week: { used: 2400000, budget: 5000000, resets_at: "2026-05-12T00:00:00-05:00" },
        },
        codex: {
          day: { used: 110000, budget: 300000, resets_at: "2026-05-08T00:00:00-05:00" },
          week: { used: 510000, budget: 1500000, resets_at: "2026-05-12T00:00:00-05:00" },
        },
      },
      agents_progress: [],
    },
    refreshing: false,
    refresh: vi.fn(),
    toast: null,
    setToast: vi.fn(),
    isDemo: false,
  }),
}));

test("renders multi-ring usage from static snapshot data", () => {
  render(<PageHeader title="Dashboard" showFleetStats />);

  expect(screen.getByText("Claude")).toBeInTheDocument();
  expect(screen.getByText("Codex")).toBeInTheDocument();
  expect(screen.getByText("5h")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/kilgore/Dropbox/Code/personal/dashboard && python3 -m unittest tests_py.test_usage_snapshot -v && npm test -- app/__tests__/page-header-usage-rings.test.tsx`
Expected: FAIL because `usage_snapshot.py` does not exist and `PageHeader` still expects the old donut shape.

- [ ] **Step 3: Implement durable snapshot + header rings**

Create `/Users/kilgore/Dropbox/Code/personal/dashboard/usage_snapshot.py`:

```python
#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
SNAPSHOT_PATH = HERE / "usage.json"


def empty_snapshot() -> dict:
    now = datetime.now().astimezone()
    return {
        "captured_at": now.isoformat(),
        "source": "local-snapshot",
        "claude": {
            "window_5h": {"used": 0, "budget": 500000, "resets_at": (now + timedelta(hours=5)).isoformat()},
            "day": {"used": 0, "budget": 1000000, "resets_at": (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0).isoformat()},
            "week": {"used": 0, "budget": 5000000, "resets_at": (now + timedelta(days=(7 - now.weekday()))).replace(hour=0, minute=0, second=0, microsecond=0).isoformat()},
        },
        "codex": {
            "day": {"used": 0, "budget": 300000, "resets_at": (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0).isoformat()},
            "week": {"used": 0, "budget": 1500000, "resets_at": (now + timedelta(days=(7 - now.weekday()))).replace(hour=0, minute=0, second=0, microsecond=0).isoformat()},
        },
    }


def write_snapshot(payload: dict) -> None:
    SNAPSHOT_PATH.write_text(json.dumps(payload, indent=2) + "\n")


if __name__ == "__main__":
    write_snapshot(empty_snapshot())
```

Modify `/Users/kilgore/Dropbox/Code/personal/dashboard/build.py`:

```python
USAGE_PATH = HERE / "usage.json"


def load_usage_snapshot() -> dict[str, Any]:
    try:
        return json.loads(USAGE_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        return {
            "captured_at": None,
            "source": "missing",
            "claude": {
                "window_5h": {"used": 0, "budget": 500000, "resets_at": None},
                "day": {"used": 0, "budget": 1000000, "resets_at": None},
                "week": {"used": 0, "budget": 5000000, "resets_at": None},
            },
            "codex": {
                "day": {"used": 0, "budget": 300000, "resets_at": None},
                "week": {"used": 0, "budget": 1500000, "resets_at": None},
            },
        }
```

Modify `/Users/kilgore/Dropbox/Code/personal/dashboard/app/PageHeader.tsx`:

```tsx
type UsageWindow = { used: number; budget: number; resets_at: string | null };
type UsageSnapshot = {
  source: string;
  claude: { window_5h: UsageWindow; day: UsageWindow; week: UsageWindow };
  codex: { day: UsageWindow; week: UsageWindow };
};

function UsageRings() {
  const { data } = useData();
  const usage = data.usage as UsageSnapshot | undefined;
  if (!usage) return null;

  return (
    <div className="usage-rings" aria-label="Usage">
      <UsageCluster
        label="Claude"
        rings={[
          { label: "wk", used: usage.claude.week.used, budget: usage.claude.week.budget },
          { label: "day", used: usage.claude.day.used, budget: usage.claude.day.budget },
          { label: "5h", used: usage.claude.window_5h.used, budget: usage.claude.window_5h.budget },
        ]}
      />
      <UsageCluster
        label="Codex"
        rings={[
          { label: "wk", used: usage.codex.week.used, budget: usage.codex.week.budget },
          { label: "day", used: usage.codex.day.used, budget: usage.codex.day.budget },
        ]}
      />
    </div>
  );
}

{showFleetStats && <UsageRings />}
```

Create `/Users/kilgore/Dropbox/Code/personal/dashboard/com.kilgore.dashboard-usage-snapshot.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.kilgore.dashboard-usage-snapshot</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/bin/python3</string>
      <string>/Users/kilgore/Dropbox/Code/personal/dashboard/usage_snapshot.py</string>
    </array>
    <key>StartInterval</key>
    <integer>60</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>/Users/kilgore/Dropbox/Code/personal/dashboard</string>
    <key>StandardOutPath</key>
    <string>/tmp/dashboard-usage-snapshot.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/dashboard-usage-snapshot.err.log</string>
  </dict>
</plist>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/kilgore/Dropbox/Code/personal/dashboard && python3 -m unittest tests_py.test_usage_snapshot -v && npm test -- app/__tests__/page-header-usage-rings.test.tsx`
Expected: PASS with the new snapshot shape and usage-cluster assertions green.

- [ ] **Step 5: Commit**

```bash
cd /Users/kilgore/Dropbox/Code/personal/dashboard
git add usage_snapshot.py tests_py/test_usage_snapshot.py usage.json com.kilgore.dashboard-usage-snapshot.plist build.py app/types.ts app/PageHeader.tsx app/globals.css app/test/fixtures/dashboard-data.ts public/data.demo.json app/__tests__/page-header-usage-rings.test.tsx
git commit -m "Replace dashboard donuts with snapshot-backed usage rings"
```

---

## Task 7: Run the Phase 3 regression suite before handoff

**Files:**
- Modify: `/Users/kilgore/Dropbox/Code/personal/dashboard/public/data.demo.json`
- Modify: `/Users/kilgore/Dropbox/Code/personal/dashboard/app/test/fixtures/dashboard-data.ts`

- [ ] **Step 1: Add the exact regression commands to the working notes**

```bash
cd /Users/kilgore/Dropbox/Code/personal/dashboard
python3 -m unittest \
  tests_py.test_build_today_projection \
  tests_py.test_search \
  tests_py.test_usage_snapshot \
  -v

npm test -- \
  app/__tests__/canonical-task-list.test.tsx \
  app/__tests__/project-detail-view.test.tsx \
  app/__tests__/search-bar.test.tsx \
  app/api/agents/__tests__/projection.test.ts \
  app/__tests__/page-header-usage-rings.test.tsx

npm run build
```

- [ ] **Step 2: Run the suite before opening the branch for review**

Run the commands above.
Expected: PASS on all Python and Vitest files, then `next build` succeeds with the new `/projects/[slug]` routes and additive `data.json` contracts.

- [ ] **Step 3: If any demo fixture drifts, fix it immediately instead of papering over type errors**

```typescript
export const dashboardDataFixture: Data = {
  generated_at: "2026-05-07T09:30:00-05:00",
  today_surface: {
    pinned: [],
    overdue_high: [],
    due_today: [],
    due_this_week: [],
    last_built_at: "2026-05-07T09:30:00-05:00",
  },
  projects_index: [],
  project_surfaces: {},
  usage: {
    source: "fixture",
    claude: {
      window_5h: { used: 0, budget: 500000, resets_at: null },
      day: { used: 0, budget: 1000000, resets_at: null },
      week: { used: 0, budget: 5000000, resets_at: null },
    },
    codex: {
      day: { used: 0, budget: 300000, resets_at: null },
      week: { used: 0, budget: 1500000, resets_at: null },
    },
  },
};
```

- [ ] **Step 4: Commit the verified final integration state**

```bash
cd /Users/kilgore/Dropbox/Code/personal/dashboard
git add public/data.demo.json app/test/fixtures/dashboard-data.ts
git commit -m "Verify dashboard phase 3 task visibility release"
```

- [ ] **Step 5: Hand off to manager + Roger with the exact ship statement**

```text
Phase 3 dashboard task visibility is ready on branch dashboard-phase-3-task-visibility.
Sequence shipped in one release: Today -> projects -> fleet -> usage.
All projection contracts are additive, Vetra-compatible, and not blocked on Prem.
```
