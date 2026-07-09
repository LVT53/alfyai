# Cross-cutting SAFETY suites (Connections feature)

Standing, CI-run regression suites that consolidate the Connections
feature's cross-cutting safety guarantees across **all** connectors into
three named files. Each per-issue test file (co-located under
`src/lib/server/services/connections/`, `chat-turn/`,
`normal-chat-tools/`) remains the deep, exhaustive suite for its own
issue; these three files are the durable, all-connectors-in-one-place
checklists so a future connector/tool/write-adapter can't be added
without the corresponding assertion.

- **`isolation.test.ts`** (Issue X.1) — user A can never reach user B's
  connections, secrets, pending writes, or connector data through the
  store, resolve layer, health checks, connection-backed chat tools, or
  the write-confirm chokepoint. Runs against a real migrated sqlite db
  (isolation is a WHERE-clause guarantee — it must be proven against a
  real query planner, not a mock).

- **`write-safety.test.ts`** (Issue X.2) — the seven-point "corruption
  firewall" checklist, for every write adapter (nextcloud, google
  calendar, apple caldav, imap email, immich album): allow_writes gate,
  explicit-confirm chokepoint, safe default destination, explicit-path
  honored-but-flagged, conditional overwrite (If-Match/etag), reversible
  delete or confirm-gated hard-delete, idempotent retry. The file header
  carries the full adapter × point matrix with explicit N/A
  justifications. Point 1's "allowWrites flipped off after propose, before
  confirm" gap (previously pinned with `it.fails`) is now fixed at the
  `confirmPendingWrite` chokepoint itself (see "point 1b" in the file) and
  asserted as a normal, passing check for every provider.

- **`locality-raw-never-leaves.test.ts`** (Issue X.3) — under Option A +
  a cloud model, raw connector payloads are provably absent from
  `JSON.stringify(modelPayload)` for every read tool (calendar, files,
  email, photos, media, location, contacts), plus the two REQUIRED 8.1
  tests: whole-outbound-context locality (not just the injected block —
  the entire assembled prompt) and the no-memory-fact/memory-boundary
  proof (proactive connector context never reaches the memory-judge
  pipeline).

Mock everything that talks to a real provider — no live credentials
anywhere in this directory.

## Not in this directory

**X.4** (Option-A fidelity live-eval harness) is a separate, pre-release
tool, not a CI-run regression suite — it needs a real local model to score
distillation fidelity against, which is out of scope for a standing test
suite that must run fast and deterministically on every push.
