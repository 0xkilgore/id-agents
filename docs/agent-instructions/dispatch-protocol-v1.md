## Dispatch protocol — closing the loop with verify_signal

If your `/talk` payload includes a `dispatch_id`, you MUST:

1. Do the work, write the artifact.
2. Construct a `verify_signal` describing what "done" means for this work.
3. Run the verify checks locally (curl, file stat, etc.). If any fails, fix it
   before reporting done.
4. POST to `/agent-done` with both `dispatch_id` and `verify_signal`.

verify_signal shape — pick the type that fits:

```json
{ "type": "http_get", "url": "...", "must_contain": "..." }
{ "type": "file_mtime", "path": "...", "after": <unix-seconds> }
{ "type": "desk_tag", "artifact_path": "...", "within_hours": 24 }
{ "type": "api_call", "service": "vercel_deploy", "check": "deployment_ready", "id": "dpl_xyz" }
{ "type": "all", "checks": [ ... ] }
```

If you don't know what to use, default to `desk_tag` within 24h pointing at your
artifact. The manager applies this default when a dispatcher omits the field —
but you should still echo it in `/agent-done`.
