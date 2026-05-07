# Walker v0.2 Local Transcription Architecture

**Date:** 2026-05-07  
**Author:** cto  
**Status:** draft for manager review  
**Urgency:** time_sensitive  
**Target window:** v0.2 build next week, after the Friday May 8 v0.1 demo

## Decision

Recommend **Option B: background queue + local worker** for Walker v0.2.

Walker should stop transcribing inline inside `POST /api/uploads/finalize`. Instead, finalize should insert the `uploads` row, enqueue an audio transcription job, and return immediately. A local worker running on Chris's machine should poll the queue, fetch the audio from Supabase Storage through a signed URL, run WhisperX locally in **single-speaker, no-diarization mode**, write the transcript back to `uploads.transcript`, and mark the queue item complete.

This is the right v0.2 shape because it preserves Chris's "run it on my own hardware" constraint without baking the product around an unreliable tunnel. It also creates the durable seam Walker will need later when "local" stops meaning "Chris's M1" and starts meaning "one customer-owned droplet per customer."

## Why Option B Wins

### Against Option A: tunneled endpoint to Chris's machine

Do not make Vercel finalize depend on a home-machine HTTP endpoint.

Problems:

- It keeps the request path coupled to the availability of one machine and one tunnel.
- Finalize still becomes a long-lived request or a fire-and-forget RPC with weak observability.
- Tunnel auth, retries, partial failures, and replay semantics become harder than they need to be.
- It is not portable to the hosted-agent future. A customer-owned droplet should not need "call back to some other box over a tunnel" as the product contract.

Option A is acceptable only as a one-off emergency bridge. It is not the v0.2 architecture.

### Against Option C: cloud GPU first

Cloud GPU is the likely v0.3+ performance path, but it is premature as the default v0.2 shape.

Problems:

- It adds spend before Walker has real transcription volume.
- It solves speed and scale, but not the immediate requirement: "default local, not OpenAI API."
- It forces infra and vendor decisions before the queue contract is proven.

The queue contract should come first. Once that exists, the worker can move from Chris's M1 to a GPU instance later without changing the Walker app-side behavior.

## Architecture Overview

### v0.1 today

Current flow in `walker-dispatch`:

1. Client uploads to Supabase Storage through signed URL flow.
2. Client calls `POST /api/uploads/finalize`.
3. Finalize verifies the object, inserts `uploads`, downloads the audio object again, and calls `transcribeIfAudio()` synchronously.
4. `transcribeIfAudio()` sends the audio to OpenAI `whisper-1`.
5. The transcript is written back to `uploads.transcript`.

This is already documented in:

- `lib/transcribe.ts`
- `app/api/uploads/finalize/route.ts`

That path is fine for the Friday May 8 demo, but it is the wrong long-term contract because transcription latency is in the request path and billing/privacy are outsourced to OpenAI.

### v0.2 target

New flow:

1. Client uploads to Supabase Storage through the existing sign/finalize flow.
2. `POST /api/uploads/finalize` verifies the object and inserts the `uploads` row exactly as it does now.
3. If `kind != 'audio'`, return immediately.
4. If `kind = 'audio'`, finalize inserts a row into `transcription_queue` and returns immediately.
5. A local worker polls for pending queue rows, claims one atomically, fetches the audio, runs WhisperX locally, writes the transcript to `uploads.transcript`, and marks the queue row `done`.
6. Admin UI shows transcript when it lands; until then transcript remains null or a pending state derived from queue status.

This is a classic async job contract. It decouples HTTP latency from transcription latency and gives Walker an explicit operational object for retries, stale claims, failures, and future routing.

## Concrete Contract Changes

### Database additions

Keep `uploads.transcript` as the canonical transcript field. Add a queue table instead of overloading `uploads`.

Recommended table:

```sql
create table if not exists transcription_queue (
  id                uuid primary key default gen_random_uuid(),
  upload_id         uuid not null references uploads(id) on delete cascade,
  status            text not null check (status in ('pending', 'processing', 'done', 'failed')),
  requested_by      text,
  priority          integer not null default 100,
  attempts          integer not null default 0,
  worker_id         text,
  claim_token       uuid,
  claimed_at        timestamptz,
  lease_expires_at  timestamptz,
  started_at        timestamptz,
  completed_at      timestamptz,
  last_heartbeat_at timestamptz,
  error             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (upload_id)
);

create index if not exists transcription_queue_status_idx
  on transcription_queue (status, created_at);

create index if not exists transcription_queue_lease_idx
  on transcription_queue (lease_expires_at);
```

Notes:

- `unique (upload_id)` prevents duplicate queue rows for the same upload.
- `claim_token` gives the worker a lease identity so stale workers cannot accidentally complete a newer claim.
- `lease_expires_at` is the stale-claim recovery mechanism.
- `attempts` is authoritative retry count.
- `status = failed` means "manual attention or backoff threshold reached," not necessarily terminal forever.

Optional but useful additions on `uploads`:

```sql
alter table uploads
  add column if not exists transcript_source text,
  add column if not exists transcript_status text,
  add column if not exists transcript_updated_at timestamptz;
```

If added, use:

- `transcript_source`: `openai-api`, `whisperx-local`, later `cloud-gpu`
- `transcript_status`: `pending`, `processing`, `done`, `failed`

These columns are convenience columns for the UI. They are not a replacement for the queue.

### Walker-side finalize behavior

Change `POST /api/uploads/finalize` as follows:

1. Preserve all current integrity checks.
2. Preserve current `uploads` insert.
3. Remove the synchronous storage-download plus `transcribeIfAudio()` call from the default path.
4. If the inserted upload is audio, enqueue exactly one queue row for that `upload_id`.
5. Return success immediately once the queue row is committed.

Recommended response addition:

```json
{
  "ok": true,
  "upload_id": "...",
  "transcription": {
    "enqueued": true,
    "mode": "local_queue"
  }
}
```

Behavioral rule:

- Failure to enqueue should not silently disappear. If the upload row exists but queue insert fails, return `500` and log aggressively. This is different from v0.1's "best effort swallow" behavior because once the app is explicitly async, queue creation is the contract.

### Worker polling and claim protocol

Use a poller, not a webhook, for v0.2.

Recommended cadence:

- Poll every 10 seconds when idle.
- If work was found on the last cycle, poll again immediately after finishing the current job.
- Optional jitter of 0-2 seconds to avoid synchronized workers later.

Claim semantics:

1. Worker selects one eligible row:
   - `status = 'pending'`
   - or `status = 'processing' and lease_expires_at < now()` for stale recovery
2. Worker atomically claims it by updating:
   - `status = 'processing'`
   - `worker_id = '<machine-name>:<pid>'`
   - `claim_token = gen_random_uuid()`
   - `claimed_at = now()`
   - `started_at = coalesce(started_at, now())`
   - `lease_expires_at = now() + interval '30 minutes'`
   - `attempts = attempts + 1`
3. Worker only proceeds if exactly one row was updated and returned.

Implementation shape:

- Best: a Postgres function or RPC that does select-and-claim in one database round trip.
- Acceptable v0.2 fallback: optimistic `update ... where id = ? and (status = 'pending' or lease_expires_at < now())` with returned row count.

Lease renewal:

- Worker updates `lease_expires_at` and `last_heartbeat_at` every 60 seconds while WhisperX is running.
- Default lease length: 30 minutes.
- This covers the observed ~19 minute wall time on a ~20 minute file with some headroom.

### Failure and retry behavior

If WhisperX crashes, the subprocess exits non-zero, the machine reboots, or the worker process dies:

- The queue row remains `processing` until `lease_expires_at`.
- Another worker cycle may reclaim it after lease expiry.

Retry policy:

- Retry automatically up to 3 attempts.
- After 3 failed attempts, mark `status = 'failed'` and persist `error`.
- Manual admin action or a SQL/scripted retry can move `failed` back to `pending`.

Failure classes:

- Transient: local worker crash, machine restart, temporary signed URL failure, storage read failure.
- Likely permanent: corrupt media file, unsupported codec, persistent WhisperX runtime error.

Recommendation:

- Signed URLs used by the worker should be minted just before fetch, not stored long-term on the queue row.
- Error text should be truncated to something safe like 2-4 KB to avoid bloating the table.

### Idempotency rules

Two idempotency cases matter:

#### 1. Duplicate enqueue attempts

Prevent with `unique (upload_id)`.

If finalize replays after upload row creation:

- Existing pending queue row should be reused or detected.
- Finalize should not create multiple queue rows for the same upload.

#### 2. Worker writes transcript but dies before marking queue row done

This must be safe to rerun.

Rules:

- Transcript write should be deterministic and overwrite-safe.
- Queue completion update must include `where id = ? and claim_token = ?` so only the current lease holder can mark the row done.
- A re-run after lease expiry may transcribe the same file again and overwrite `uploads.transcript` with materially equivalent text. That is acceptable in v0.2.

If Chris wants stronger idempotency later, add an output artifact hash or transcript versioning. Not needed for v0.2.

### Backwards compatibility and fallback

Do **not** hard cut the OpenAI path immediately.

v0.2 should support:

- `TRANSCRIPTION_MODE=local_queue` as the default target state
- `TRANSCRIPTION_MODE=openai_inline` as emergency fallback
- optionally `TRANSCRIPTION_MODE=off` for debugging

Interpretation:

- `local_queue`: enqueue into `transcription_queue`
- `openai_inline`: keep using the current `transcribeIfAudio()` flow
- `off`: do not transcribe

Reasoning:

- Friday's demo is already on OpenAI.
- The local worker will be new operational machinery.
- Chris should be able to flip back to OpenAI without redeploying architecture if the M1 worker is down.

`transcribeIfAudio()` should stay in the codebase in v0.2, but it stops being the default path.

## Local WhisperX Worker Shape

### Location

Best v0.2 choice: a **separate repo/service** rather than a sub-package inside the Vercel app.

Recommended path:

- `~/Dropbox/Code/walker-dispatch-worker/`

Reasoning:

- It has a different runtime model than the Next.js app.
- It will want its own Python or mixed Python/Node environment.
- It is operationally closer to `cane-poller` than to a browser-facing app route.
- It should stay portable to "customer droplet worker" later.

Acceptable alternative:

- keep it in the Walker repo as a `worker/` package if Chris wants single-repo ergonomics

My recommendation is still separate repo. The deployment boundary is real.

### Supervision on Chris's machine

Run it under `launchd`, same philosophy as `cane-poller`.

Deliverables:

- one executable script, e.g. `bin/walker-transcription-worker`
- one `launchd` plist with `KeepAlive`
- logs written to a stable path under `~/Library/Logs/` or the repo `logs/` dir

The worker must restart automatically on reboot. This is the whole point of choosing queue + daemon over tunnel-RPC.

### Polling cadence

Recommended:

- idle poll every 10 seconds
- heartbeat every 60 seconds during active transcription
- if a job just completed, immediately look for another job before sleeping

30 seconds is workable, but 10 seconds feels better operationally and still costs essentially nothing.

### How the worker calls WhisperX

For v0.2, call the already-verified local binary as a subprocess:

- binary: `~/Dropbox/Code/personal/whisper-venv/bin/whisperx`

Suggested invocation pattern:

```bash
~/Dropbox/Code/personal/whisper-venv/bin/whisperx \
  /tmp/walker-input.m4a \
  --model medium \
  --language en \
  --output_format json \
  --output_dir /tmp/walker-whisperx-out
```

Explicitly do **not** pass `--diarize`.

Worker steps:

1. Mint a signed URL for the `uploads.storage_path`.
2. Download the file to a temp path.
3. Run WhisperX subprocess.
4. Parse the output JSON.
5. Flatten segments into a single transcript string for `uploads.transcript`.
6. Update `uploads.transcript`, `transcript_source`, `transcript_status`, `transcript_updated_at`.
7. Mark queue row `done`.
8. Clean up temp files.

Single-speaker rule:

- Walker v0.2 treats all audio as a single stream.
- Multiple speakers, if present, will be transcribed into one transcript with no speaker tags.
- Diarization is intentionally deferred to v0.3.

### Model selection

Recommendation for v0.2 default: **`medium`**, with `large-v3` available via config.

Reasoning:

- Chris's verified run used `large-v3 + diarization` for a heavier Cane use case.
- Walker v0.2 is single-speaker and operational, not archival/podcast-grade.
- Faster turnaround matters more than squeezing the last few points of quality out of the transcript.
- Medium is the more practical dogfooding default on home hardware and small future droplets.

Recommended env:

- `WHISPERX_MODEL=medium` for default
- allow `large-v3` override for quality testing or production tuning

If Chris decides quality clearly suffers on job-site recordings, switch the default to `large-v3` after real sample evaluation. The architecture does not change.

### Heartbeat pattern

Use both DB heartbeat and file heartbeat.

1. DB heartbeat:
   - update `last_heartbeat_at`
   - extend `lease_expires_at`

2. File heartbeat:
   - touch a file such as `~/Library/Application Support/walker-dispatch-worker/heartbeat.txt`
   - include last cycle time, worker id, and current queue item if any

This mirrors the cane poller pattern and gives Chris a dead-simple "is it alive?" check outside the database.

## Product Frame: Walker Hosted-Agent Portability

This design is not just for Chris's machine. It is the prototype for the hosted Walker product shape described in `~/Dropbox/Code/agent-platform/ideas.md` on 2026-05-06.

The key portability property is:

- Walker app writes "transcription requested" into Postgres.
- A worker process somewhere claims and fulfills the job.

That worker can later run:

- on Chris's M1 at home
- on a customer-owned CPU droplet
- on a customer-owned GPU droplet
- on a shared cloud worker pool

The Walker web app does not need to care.

That portability is the main architectural advantage of Option B. It keeps the app-side contract stable while the execution substrate changes.

## Migration Path From v0.1

### Cutover strategy

Friday May 8 demo stays on v0.1 as-is with OpenAI Whisper API.

v0.2 cutover next week:

1. Deploy schema migration adding `transcription_queue` and any optional transcript metadata columns.
2. Deploy Walker app change that honors `TRANSCRIPTION_MODE`.
3. Initially keep `TRANSCRIPTION_MODE=openai_inline` in production if Chris wants a safe deploy.
4. Start and verify the local worker on the M1 or M4.
5. Flip `TRANSCRIPTION_MODE=local_queue`.
6. Observe new uploads end-to-end.

No historical transcript migration is required.

Existing rows in `uploads.transcript` remain as they are. v0.2 only changes how future audio uploads get transcribed.

### What happens to existing transcripts

Nothing. They remain in `uploads.transcript`.

There is no reason to re-transcribe old v0.1 uploads unless Chris explicitly wants a backfill for quality or residency reasons. That is optional follow-on work, not part of this spec.

### Should OpenAI fallback remain?

Yes, in v0.2.

Keep `OPENAI_API_KEY` in Walker Vercel env even after local queue is live.

Reasoning:

- It is an emergency fallback if the worker is down before an important demo or customer use.
- It lowers cutover risk during the first week.
- Removing the key does not materially simplify the system yet.

Longer term, once the local worker path is stable, OpenAI can move from "fallback" to "disabled by policy unless explicitly enabled."

## v0.2 Scope

In scope:

- single-speaker transcription only
- no diarization
- async queue + local worker
- WhisperX local subprocess
- `medium` or `large-v3` configurable model
- retry, stale-lease recovery, and operational heartbeat
- OpenAI path retained as fallback

Out of scope:

- speaker diarization
- speaker identification / voice fingerprinting
- chunked parallel transcription
- cloud GPU worker as default
- multi-tenant worker dispatch policy
- admin retry UI

## v0.3 Flags From Here

Not part of this spec, but the queue design should anticipate:

- per-upload diarization toggle, probably from admin
- voice-fingerprint mapping for known speakers
- GPU-backed worker option
- customer-specific worker routing
- multi-tenant queue controls once Walker customer 2 exists

The reason to get v0.2 right is that all of those features become worker-side changes once the queue boundary exists.

## Implementation Notes For The Planner

When this moves from review to plan-writing:

1. Update `db/schema.sql` with queue table and indexes.
2. Add a small `lib/transcription-mode.ts` or equivalent env gate.
3. Refactor `app/api/uploads/finalize/route.ts` so audio handling branches by mode.
4. Keep `lib/transcribe.ts` intact for fallback.
5. Add tests:
   - finalize enqueues audio in `local_queue` mode
   - finalize does not enqueue non-audio
   - finalize preserves existing idempotency behavior
   - duplicate enqueue prevented for same `upload_id`
   - fallback mode still calls `transcribeIfAudio()`
6. Build worker repo with config, polling loop, claim/lease logic, signed URL fetch, WhisperX subprocess, transcript writeback, and launchd install docs.

## Bottom Line

Walker v0.2 should move to **queue + local worker** now, keep **single-speaker only**, and retain the **OpenAI API path only as an env-controlled fallback**. That gives Chris the local/privacy/cost story he wants immediately while preserving the exact architectural seam Walker will need when "Chris's M1" becomes "customer-owned hosted agent."
