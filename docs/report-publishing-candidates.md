# Report candidate handoff

Agent Manager supports an optional, additive `report_candidate` object on an
authenticated successful `POST /agent-done`. This is a nomination boundary,
not a publishing API.

The manager validates the closed `report-candidate.v1` schema before changing
dispatch state. It derives artifact path, source identity, producer identity,
default report identity, and occurrence time from trusted dispatch context.
After completion commits, it writes one canonical
`report-promotion-request.v1` JSON file to `REPORT_PROMOTION_REQUEST_DIR`.

Set that variable only to an absolute, canonical, owner-owned `0700` directory.
Request files are `0600`. The manager has no Vetra producer credential and does
not contact the Report Registry.

The completion receipt includes `receipt.report_candidate` with one of:

- `recorded`: a new request was stored;
- `already_recorded`: an identical retry found the same request;
- `not_configured`: no handoff directory is configured;
- `conflict`: the stable dispatch source already has different metadata;
- `write_failed`: the private handoff could not be admitted or written.

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
