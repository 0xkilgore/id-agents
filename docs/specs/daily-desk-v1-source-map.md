# Daily Desk v1 source map

Task: `build-kapelle-daily-desk-a2`

`GET /daily-desk` is an additive manager-owned read projection. Its lane order is fixed as Today, Review next, Needs a response, Follow-through.

| Lane | Canonical source/read model | Admission | Cap |
| --- | --- | --- | ---: |
| Today | `tasks` through the existing `taskRowToEntry` / task-band classifier | open, non-archived rows whose canonical band is `today` for the requested fixed date | 8 |
| Review next | existing `listReviewNextSourceRows` + `buildReviewNextResponse` | A1 unchanged; no cloned eligibility, ranking, cursor, freshness, or action logic | 5 |
| Needs a response | `inbox_items` joined to explicit `daily_desk_lane_metadata` registration | operator + production, unresolved `new`/`needs_route`/`output_ready`, action/approval classification, no resolved timestamp | 5 |
| Follow-through | `checkins` joined to its open linked `tasks` row and explicit `daily_desk_lane_metadata` registration | operator + production, active checkin, open linked task, no expired/closed/snoozed watch | 5 |

The additive metadata table supplies explicit audience, environment, lifecycle, canonical URL, admission code/detail, source time, owner, and permitted actions where the existing Inbox and Checkin substrates do not carry those fields. It does not mutate source rows.

Production admission remains default-deny. `/agent-done` and `/artifacts/register` persist Review-next metadata only when the writer supplies the explicit `review_next` contract; approval or rejection retires that registration. An admin/operator-created checkin is registered for Follow-through only when it has an explicit owner and an open linked task. The live artifact availability, checkin status/TTL, and linked task lifecycle remain the removal authority, so missing or terminal rows disappear without a console-side filter.

The response ceiling is 65,536 UTF-8 bytes. Console reads are capped at the same value and reject before JSON parsing when the stream crosses the limit. Bounded string limits are 256 characters for IDs/titles, 128 for owners/lifecycle/admission codes, 240 for reasons, and 1,024 for canonical URLs. The console makes one `/daily-desk` manager read per refresh.

Rollback is additive: reverting the manager promotion removes only the route, projection, and metadata table creation; A1 `/artifacts/review-next` and its data remain intact.
