# Report candidate handoff

Agent Manager supports an optional, additive `report_candidate` object on an
authenticated successful `POST /agent-done`. This is a nomination boundary,
not a publishing API.

The manager validates the closed `report-candidate.v1` schema before changing
dispatch state. It derives artifact path, source identity, producer identity,
default report identity, completion-time SHA-256/byte size, and occurrence time
from trusted dispatch context. Because current `/agent-done` authentication does
not identify an individual agent, the honest producer is `SERVICE:agent-manager`.

The canonical `report-promotion-request.v2` is stored on the dispatch row in the
same terminal database update. A boot/periodic outbox worker exports it to
`REPORT_PROMOTION_REQUEST_DIR`; an export crash or unavailable directory cannot
erase the nomination.

Terminal writes are database compare-and-set operations on both SQLite and
PostgreSQL. The first success/failure/cancellation wins; an exact simultaneous
or later retry recovers the winner, while a conflicting result, promotion
record, or report candidate is rejected
before artifact, inbox, query, or candidate projections and cannot overwrite
the stored result or candidate. Classifier bounces return a bounced receipt and
do not run success projections. Malformed durable outbox rows are quarantined
individually so later valid requests continue exporting.

Set `REPORT_PROMOTION_ALLOWED_ROOT` to the absolute canonical output root.
Candidates must be canonical, single-link, nonempty valid UTF-8 Markdown at
most 256 KiB beneath it. Set `REPORT_PROMOTION_REQUEST_DIR` only to an absolute,
canonical, owner-owned `0700` directory.
Request files are `0600`. The manager has no Vetra producer credential and does
not contact the Report Registry.

The completion receipt includes `receipt.report_candidate` with one of:

- `recorded`: a new request was stored;
- `already_recorded`: an identical retry found the same request;
- `not_configured`: no handoff directory is configured;
- `conflict`: the stable dispatch source already has different metadata;
- `write_failed`: the private handoff could not be admitted or written.

Receipts return stable candidate identity and status, not the Manager's private
absolute handoff path. Legacy closeouts without a candidate keep their prior
receipt shape and omit `report_candidate` entirely.

Malformed candidate input returns `400` before dispatch completion. A storage
failure after completion is explicit in the receipt and does not unwind the
successful dispatch.

Candidate shape:

```json
{
  "schema_version": "report-candidate.v1",
  "title": "Optional title",
  "report_ref": "report:optional:stable-ref",
  "project_ref": "project:optional",
  "family_ref": "family:optional",
  "attention": {
    "request": "NONE"
  }
}
```

Attention is never inferred. The allowed requests are `NONE`, `READ`, `ANSWER`,
`DECIDE`, `APPROVE`, and `REQUEST_CHANGE`; non-`NONE` requests may carry an
explicit reason, reason code, review deadline, and expiry.
