# ID Agents Setup Log

Last updated: 2026-04-16 by Claude Code session (app instance)

---

## 1. What's Deployed and Running

### ID Agents Manager
- **Port:** 4100
- **Config:** `~/Code/cane/id-agents/configs/kilgore-team.yaml`
- **Version:** 0.1.36-beta (upgrade to 0.1.43-beta pending — has `/sync` and orphan fix)
- **Host:** M4 workstation (blitz.local / 10.0.0.99)

### Agents (11 total, all online as of Apr 16)

| Agent | Port | Working Dir | Purpose |
|-------|------|-------------|---------|
| cane | 4120 | ~/Code/cane | Infrastructure, taskview, email/Telegram poller, calendar, transcription |
| finances | 4121 | ~/Code/finances | Monthly expenses, dashboards, budget analysis |
| personal | 4122 | ~/Code/personal | Health, running, fantasy sports, house expansion, politics |
| pipeline | 4123 | ~/Code/pipeline | Networking, job search, opportunities, NYC contacts |
| cleveland-park | 4124 | ~/Code/cleveland-park | Neighborhood association, website, newsletter, events |
| trinity | 4125 | ~/Code/trinity | Church board, finance committee, fundraising |
| defi | 4126 | ~/Code/defi | DeFi research, vault landscape, product opportunities |
| agent-platform | 4127 | ~/Code/agent-platform | Personal agent product research |
| roger | 4128 | ~/Code/roger | Dedicated coding agent. Specs in, code out. |
| sentinel | 4129 | ~/Code/sentinel | Verification agent. 2hr scheduled checks. |
| vault-institutional | 4116 | ~/Code/vault-institutional | Legacy duplicate of defi — still running, should eventually remove |

### M1 Mac Mini (tsharkz.local)
- **M1 agent:** Separate deployment, not in kilgore-team.yaml
- **LaunchAgents running:**
  - `com.kilgore.cane-poller` — always-on IMAP/Telegram poller
  - `com.kilgore.morning-digest` — M-F 7:15 AM email digest
  - `com.kilgore.taskview` — daily 6:30 AM task digest
  - `com.kilgore.fantasy-scout` — Sat 11:00 AM (was broken, Roger spec 022 dispatched to fix)
  - `com.kilgore.fangraphs-sync` — dispatched to Cane agent to create (daily 6 AM)
- **Python:** `/Library/Frameworks/Python.framework/Versions/3.11/bin/python3`
- **SSH:** `ssh chrispowers@tsharkz.local` (NOT kilgore — that's the M4)

### Vercel Deployments
- clevelandparktn.com — Cleveland Park website (Next.js, auto-deploys from GitHub)
- health.caneyfork.dev — Health dashboard
- finances dashboard — finances.caneyfork.dev (?)
- Marathon spectator guide — local only at `~/Code/personal/running/marathon-spectator-guide.html`

---

## 2. What Was Built (This Session, Apr 15-16)

### Cleveland Park
- Meeting notes finalized (Apr 9 meeting) — David Best corrected, Sam removed, East Bend added
- **Meeting Notes page built for website** — Roger spec 020. New `/meetings` route and `/meetings/[slug]` detail pages. Data-driven via `meeting-notes.json`. Nav updated. Deployed to Vercel.
- Newsletter draft written — `cleveland-park/newsletter-draft-2026-04.md` (post-meeting version, ready for MailerLite)
- Summer Enrichment Program flyer saved to `assets/flyers/summer-enrichment-program.jpg`
- Alex Abels emails read from IMAP — Friends of East Nashville Parks coalition + East Bend zoning letter
- WhatsApp parents group created and launched. Join link: `https://chat.whatsapp.com/GzATeJQI6VE7YTa8GftXNg?mode=gi_t`
- CP Parents logo (SVG) at `~/Downloads/cp-parents-logo.svg`
- 5 contacts exported as VCF for WhatsApp group
- CLAUDE.md updated with Meeting Notes publishing instructions

### FlowMo / Carter
- Read both Apr 9 call transcripts (fundraising + product demo)
- Created `pipeline/notes/carter-flowmo/` with `summary.md` (comprehensive) and both transcripts
- Tested FlowMo product with dummy D2C data on BigQuery (4 tables: shopify_orders, meta_ads, ga_sessions, customers)
- Generated dummy data at `~/Downloads/flowmo-test-data/`
- BigQuery project: `email-455414`, dataset: `flowmo_test`
- Roger built visual feedback report: `pipeline/notes/carter-flowmo/flowmo-feedback-report.html` (spec 021, 2.7MB with embedded screenshots)
- Detailed product feedback captured in summary.md

### Marathon
- Spectator guide HTML at `~/Code/personal/running/marathon-spectator-guide.html`
- Built from official 2026 road closure PDFs (in Downloads)
- Two stops: Woodland Bridge (mile 17) + Fatherland & S 5th (mile 19)
- Local server was running at `http://10.0.0.99:8888/marathon-spectator-guide.html`

### DeFi
- Created `defi-drafts/defi-product-ideas.md` — working doc for product brainstorming
- Created `defi-drafts/dose-of-defi-article-draft.md` — article collaboration with Daniel MacLennan
- Deep dive session moved to ongoing (due Apr 18)
- Dean Eigenmann outreach un-done (wasn't actually sent), draft ready at `pipeline/drafts/dean-eigenman-outreach.md`

### Obsidian
- Cleaned up vault — moved sentinel reports to `sentinel/` folder, loose files into project folders
- Removed `sentinel-reports` symlink (was pointing to empty dir), removed `Untitled` folder
- Created `Dashboard.md` with wikilinks to all project files
- Updated Sentinel CLAUDE.md to write to `Obsidian/sentinel/` not root
- Created `contacts/`, `daily/` folders

### Infrastructure
- Downloads mirror: Automator Folder Action created (`~/Library/Workflows/Applications/Folder Actions/Copy to Cane Downloads.workflow`) — watches Downloads, copies to `~/Code/cane/downloads/`. **Not confirmed working** — needs debugging (to-do exists).
- LaunchAgent plist also created but TCC blocks it: `~/Library/LaunchAgents/com.cane.downloads-sync.plist` (unloaded, needs Full Disk Access to work)

### Task Management
- Processed 18 Trello cards from Chris Does "Today" list — archived 11, moved 5 to Agent board, 2 to Politics board, 2 to DeFi to-dos
- Major overdue triage: life insurance, bank lockbox, architect consultations → May 5 monthly finance check-in. iPhone, running gear → archived. M0 → today.
- Created Chicago trip to-do (Elliot, Getty/Oku, Calvin Chu)

### Roger Specs Dispatched
- 020: Cleveland Park meeting notes page ✅
- 021: FlowMo feedback report ✅
- 022: Fix fantasy baseball Saturday email ✅ (completion note exists, need to verify fix)

---

## 3. Half-Done / In-Flight

| Item | Status | Context |
|------|--------|---------|
| Cleveland Park newsletter | Draft ready, not sent via MailerLite | `cleveland-park/newsletter-draft-2026-04.md` — needs final review + MailerLite send |
| Carter FlowMo feedback | Report built, not sent to Carter | `pipeline/notes/carter-flowmo/flowmo-feedback-report.html` — Chris wants to do more FlowMo testing first |
| System check-in report | Task exists, no Roger spec written yet | Needs a script that pulls taskview + inbox + agent health + Roger completions, sends via cane_email.py, scheduled on M1 |
| DeFi deep dive | In progress, extended to Apr 18 | Chris consuming podcasts, filling in product ideas doc + article draft |
| Dean Eigenmann outreach | Draft ready, not sent | `pipeline/drafts/dean-eigenman-outreach.md` — X/Twitter DM |
| Walker Bloodworth outreach | Due today (Apr 16), not done yet | Text/call about construction AI implementation |
| M0 application | Due today (Apr 16) | `m0.org`, VP Marketing, know the CEO |
| LinkedIn profile update | Due today (Apr 16) | In job-search to-do |
| Safe Haven breakfast email | Due today (Apr 16) | Forward to Trinity board, ask if attending Apr 21 |
| Fangraphs sync on M1 | Dispatched to Cane agent | Need to verify launchd plist was created |
| Fantasy baseball Saturday email | Roger spec 022 completed | Need to verify actually fixed on M1 |
| Nashville demographics research | Dispatched to personal agent | Report at `Obsidian/pipeline-notes/nashville-demographics-research.md` (23KB, done) |
| ID Agents upgrade to 0.1.43 | Due Apr 17 | Test `/sync` command. Discuss with Prem at Friday check-in |
| Downloads folder sync | Automator action created, not confirmed working | To-do exists, due Apr 17 |

---

## 4. Gotchas & Learned Wisdom

### Deployment
- `register: false` must be set in kilgore-team.yaml defaults — agents try to register on-chain otherwise and fail
- `/deploy` used to leave orphan processes on old ports — fixed in 0.1.43
- Delete `~/.id-agents/` SQLite database when ghost agents accumulate from failed deploys
- `getDeployerAddress()` was changed to return null instead of throwing — all callers handle null

### macOS / TCC
- Terminal cannot read `~/Downloads` directory listing without Full Disk Access
- Individual file reads work if you give the explicit path
- Automator Folder Actions bypass TCC (run with Finder permissions)
- LaunchAgent plists that read Downloads will fail without Full Disk Access

### Dropbox / Sync
- Dropbox is sole sync mechanism for task files between M4 and M1
- VPS rsync was disabled 2026-03-24 (was causing overwrites)
- M1 Dropbox path: `~/Dropbox/` is a symlink to `~/Library/CloudStorage/Dropbox/`

### Vercel
- Cleveland Park website sometimes fails to deploy via GitHub webhook (transient errors)
- Manual `npx vercel --prod` from the project dir always works
- Node version mismatches can cause failures — Next.js 16 needs Node 22+

### Agent Communication
- Agents are REST endpoints: `POST http://localhost:{port}/talk` with `{"message": "..."}`
- Manager is at 4100 but `/talk-to/{agent}` route doesn't work — hit agents directly on their ports
- `/news` endpoint returns recent messages but sometimes empty
- Health check: `GET http://localhost:4100/agents` returns all agents with health status

### Sentinel
- Reports go to `~/Dropbox/Obsidian/sentinel/sentinel-report-{date}-{time}.md`
- CLAUDE.md updated to use this path (was writing to Obsidian root before)
- Runs on 2hr schedule via ID Agents manager `/schedule`
- Sentinel's due-today data can be stale — it reads taskview at check time

### Roger (Coding Agent)
- Specs go in `~/Code/roger/specs/`, completions in `~/Code/roger/completed/`
- Dispatch via `POST http://localhost:4128/talk`
- Roger works on any project — give him the full path
- Small specs work better than big ones (morning digest failed 4 times as one big spec, succeeded when broken into 016-019)
- Always tell Roger to run `npm run build` or equivalent to verify

### Fantasy Baseball
- Bot at `~/Code/personal/fantasy-baseball/bot.py` — always `refresh` before any analysis
- RotoWire projections via `roto_fetch.py` (Playwright, authenticated)
- 3 acquisitions per matchup week (Mon-Sun)
- Saturday night = drop/pickup window for 2-start SPs

---

## 5. Active Debugging / Open Questions

- **Downloads folder sync** — Automator Folder Action was created and attached to Downloads but the mirror folder (`~/Code/cane/downloads/`) stayed empty. May need to test by dropping a new file in Downloads.
- **Fantasy baseball Saturday email** — Roger completed spec 022 but haven't verified the actual fix on M1. Need to check the plist and test.
- **Fangraphs sync plist** — Dispatched to Cane agent to create on M1. Haven't confirmed it was created.
- **vault-institutional agent (port 4116)** — Legacy duplicate of defi agent. Still running. Should be removed from config eventually.
- **System check-in report** — Concept is clear (combine taskview + inbox + agent health into scheduled email) but no code written yet. Roger spec needed.

---

## 6. Useful Commands

```bash
# Agent management
curl -s http://localhost:4100/agents | python3 -m json.tool  # list all agents
curl -s -X POST http://localhost:4128/talk -H "Content-Type: application/json" -d '{"message": "..."}'  # talk to Roger
curl -s -X POST http://localhost:4129/talk -H "Content-Type: application/json" -d '{"message": "..."}'  # talk to Sentinel

# Taskview
/opt/homebrew/bin/python3 ~/Code/cane/taskview/taskview.py view --due today
/opt/homebrew/bin/python3 ~/Code/cane/taskview/taskview.py add "task" -p project --priority high --due today
/opt/homebrew/bin/python3 ~/Code/cane/taskview/taskview.py done "substring" --first

# Trello
/opt/homebrew/bin/python3 ~/Code/cane/taskview/trello.py boards
/opt/homebrew/bin/python3 ~/Code/cane/taskview/trello.py cards {list_id}
/opt/homebrew/bin/python3 ~/Code/cane/taskview/trello.py archive {card_shortlink}

# IMAP (read Cane email directly)
# See cane_poller.py for connection details: imap.purelymail.com, cane@caneyfork.dev
# Credentials in ~/Code/cane/taskview/.env.cane

# M1 SSH
ssh chrispowers@tsharkz.local

# Vercel deploy (Cleveland Park)
cd ~/Code/cleveland-park/cleveland-park-website && npx vercel --prod

# ID Agents deploy
cd ~/Code/cane/id-agents && npm run deploy -- --config configs/kilgore-team.yaml

# Local web server (for sharing HTML files on network)
cd /path/to/folder && python3 -m http.server 8888
# Access from phone: http://10.0.0.99:8888/filename.html
```

---

## 7. Config Paths & File Locations

| What | Path |
|------|------|
| ID Agents config | `~/Code/cane/id-agents/configs/kilgore-team.yaml` |
| ID Agents source | `~/Code/cane/id-agents/` |
| Taskview / Cane CLI | `~/Code/cane/taskview/` |
| Cane poller | `~/Code/cane/taskview/cane_poller.py` (M1: `otto_poller.py`) |
| Morning digest | `~/Code/cane/taskview/morning_digest.py` |
| Cane email sender | `~/Code/cane/taskview/cane_email.py` |
| RSS feeds config | `~/Code/cane/taskview/feeds.yaml` |
| Roger specs | `~/Code/roger/specs/` |
| Roger completions | `~/Code/roger/completed/` |
| Sentinel CLAUDE.md | `~/Code/sentinel/CLAUDE.md` |
| Obsidian vault | `~/Dropbox/Obsidian/` |
| Obsidian Dashboard | `~/Dropbox/Obsidian/Dashboard.md` |
| Global CLAUDE.md | `~/.claude/CLAUDE.md` |
| Memory files | `~/.claude/projects/-Users-kilgore-Dropbox-Code/memory/` |
| LaunchAgents (M4) | `~/Library/LaunchAgents/` |
| LaunchAgents (M1) | `chrispowers@tsharkz:~/Library/LaunchAgents/` |
| Env files (Cane) | `~/Code/cane/taskview/.env`, `.env.cane`, `.env.otto` |
| Cleveland Park website | `~/Code/cleveland-park/cleveland-park-website/` |
| FlowMo feedback | `~/Code/pipeline/notes/carter-flowmo/` |
| Marathon guide | `~/Code/personal/running/marathon-spectator-guide.html` |
| Downloads mirror | `~/Code/cane/downloads/` (via launchd `com.cane.downloads-sync` plist — WatchPaths on `~/Downloads`, rsync `--ignore-existing`. Confirmed working 2026-04-17.) |

---

## Two-Manager Architecture

As of Apr 16, two Claude instances are running:

- **App instance (this session):** Human-facing triage, orchestration, inbox processing, agent dispatch, non-code work
- **IDE instance:** Code work, ID Agents infrastructure, Roger dispatch, deep codebase context

**Shared bus (no direct messaging):**
- `~/Code/*/to-do.md` — taskview
- `~/Code/cane/taskview/inbox.md` — unprocessed items
- `~/Dropbox/Obsidian/sentinel/` — Sentinel reports
- `MEMORY.md` + `~/.claude/CLAUDE.md` — persistent context
- This file (`SETUP_LOG.md`) — session-specific context
