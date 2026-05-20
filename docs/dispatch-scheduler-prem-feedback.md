# Feedback for Prem — Harness Backpressure (Anthropic Throttle Class)

**Context:** Over the past two weeks we've lost ~5–6 builds to
Anthropic returning server-side throttles like `Server is temporarily
limiting requests` when our local manager issued ~8 parallel /talk
dispatches. The harness has no backpressure: each /talk arrives at the
provider eagerly, gets throttled, and the build dies with a generic
error that doesn't distinguish "your code is bad" from "provider
saturated, retry later."

**Local mitigation we shipped:**
We added a substrate-level gateway in front of the harness: a
concurrency-aware Dispatch scheduler in the manager process. The
manager now enqueues a Dispatch doc per dispatchable unit of work; the
scheduler drains the queue at a safe-cap concurrency (defaulting to
`max_in_flight_anthropic = 3` for Anthropic). When a provider throttle
fires after start, we classify it (`Server is temporarily limiting
requests`, HTTP 429/529, capacity language), mark the doc `bounced`
with `not_before_at = now + backoff(attempt)` (30s→5m capped,
jittered), and free the slot. The next tick requeues and retries up
to 5 attempts before terminal-failing with
`provider_rate_limit_exhausted`.

This keeps the manager dispatch flow safe under operator burst behaviour
without touching harness internals. The full plan is at
`docs/superpowers/plans/2026-05-19-concurrency-scheduler.md`; the
operator rollout guide is `docs/dispatch-scheduler-rollout.md`.

## What we'd love from the harness

1. **Explicit backpressure signal.** When the harness or its provider
   layer detects sustained throttling, emit a signal we can consume —
   ideally with `retry_after_ms` metadata — instead of letting the
   request die at the call site. Today we infer it from a string match
   on the response body.

2. **Distinguish throttle from agent error.** Right now any
   non-2xx + non-empty body reaches the build as "the agent failed."
   A small enum (`provider_throttle | provider_auth_error |
   agent_error | transport_error`) on the harness response would let
   us avoid the string-match classifier we wrote locally.

3. **Concurrent-request meta.** Even a coarse counter the harness
   exposes — "you currently have N requests in flight against this
   provider" — would let our scheduler get out of the business of
   estimating from in-process state. We'd happily target a harness
   API like `GET /harness/concurrency` and let it return
   `{ provider, in_flight, observed_max_before_throttle }`.

4. **Optional retry-after delegation.** If the harness can be told
   "yes, I want to retry this when the provider says so," we'd offload
   the backoff logic to it instead of running our own
   `computeBackoffMs(attempt, policy, rng)`.

None of these are blocking. The local gateway already ends the lost-
build class. But upstream support would shrink the surface area we
have to maintain, and benefit every harness consumer who hits the
same wall.

## What we are NOT asking for

- Don't fork the harness. We're deliberately staying off the upstream
  fork path. The gateway is a manager-side concern; the harness should
  remain free to evolve.
- Don't add backpressure semantics that would silently delay a
  request without the caller knowing. The gateway already provides
  the visible queue + bounce-and-requeue audit trail; another implicit
  buffer below us would just hide where time is being spent.

If any of the above is in scope for the harness roadmap, happy to
share the classifier patterns + backoff policy we settled on as a
starting point.
