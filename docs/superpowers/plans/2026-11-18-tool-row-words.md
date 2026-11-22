# Tool Rows That Say What Happened Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The owner's standing choice for big builds is native execution (superpowers:executing-plans) in two parallel tracks on disjoint files, with one Opus review of the whole branch at the end; see "Tracks and coordination".

**Goal:** Every opened tool row in the chat gives a little more than the tool's name in plain English and Hungarian, and every error case a tool's server code tells apart reaches the person as its own friendly sentence (never a code, an exception or the model's note), enforced by a rule and a test.

**Architecture:** The server names each failure, refusal or notable outcome with a reason code from one closed list per tool (`src/lib/shared/tool-reasons.ts`) and writes it on the tool-call segment's metadata (`metadata.reasonCode`) without changing anything the model reads. The browser maps each code to a kind (fail, stop, info, empty) and an i18n key in one registry (`src/lib/utils/tool-reason-words.ts`), and the row builders in `src/lib/utils/tool-activity.ts` draw the row from that. The raw cause is logged once, content-free.

**Tech Stack:** SvelteKit 2 with Svelte 5 runes, TypeScript, Vitest with @testing-library/svelte, Playwright, the app's own i18n (`src/lib/i18n/`).

**Spec:** `docs/superpowers/specs/2026-11-18-tool-row-words-design.md` (approved 2026-11-18), with the approved screens in `docs/superpowers/specs/2026-11-18-tool-row-words/`. Read the spec first: its section 5 holds the sentences, which this plan does not repeat. This plan adds the codes, words and decisions the spec left to the builder, marked "(plan)".

## Global Constraints

- The model sees exactly what it sees today. No change to any model payload, `outputSummary`, refusal text, the tool catalogue (`src/lib/server/services/normal-chat-tools/tool-catalogue.en.snapshot.txt` must stay byte-identical), or a segment's stored `status`: the history digest derives `ok` from `status` (`src/lib/server/services/chat-turn/conversation-history.ts:81-110`). Reason codes and display copies ride on `metadata` only, which no model request reads.
- Where a call recorded no entry before (the schema failures of read_generated_file, create_artifact and edit_artifact), the new entry has `status: "done"`, no `outputSummary`, no `resultDigest` and no candidates, so the history digest stays the "Completed." it is today (`stream-orchestrator.ts:1286-1298` fills the segment from the entry; `conversation-history.ts:106`; `ask-capture.ts:75`). A test pins `buildHistoryToolDigest` of such an entry.
- The metadata key is `reasonCode`. `metadata.errorCode` is taken: it is the stream's `StreamErrorCode` on `tool_error` segments (`chat-turn/stream-orchestrator.ts:1307-1345`).
- A code travels beside an in-band payload, never inside it: `withReasonCode(payload, code)` / `reasonCodeOf(payload)` (Task A1), a WeakMap side table like `withToolExecutionFact` (`normal-chat-tools/shared.ts:173`). `JSON.stringify(payload)` is unchanged by tagging.
- Raw text never reaches a row: no string from `outputSummary`, `metadata.error`, `resultDigest`, a call's input names or ids, an exception or an HTTP status appears in any `ToolActivityItem` string (verb, object, objectSuffix, meta, title, summaryLabel, body text). Things the tool returned by their own names (titles, hosts, file names, the person's own input words such as a search query or a place) are allowed.
- Every new person-facing word is in `src/lib/i18n/tool-rows.ts` (prefix `toolRows.`) in both `en` and `hu`, except where a task changes an existing key in place. Hungarian is short and natural, fits a 360 and 390 px row, uses "készség" for skill, and no value in either language contains "artifact" or "artefakt".
- Logging is content-free: `[CHAT_STREAM] tool_failure tool=<name> code=<code|none> status=<status>` plus, for a thrown error, `error=<Error class>: <message>`, the message on one line with every URL replaced by `<url>` and every quoted span (`"…"`, `'…'`, `` `…` ``) by `<text>`, then cut to 200 characters (some messages echo the model's input, for example `connections/dav/ical.ts:347`). Never inputs, results, `outputSummary` or candidates.
- Thumbnails load only through `imageThumbnailRouteUrl` (`src/lib/shared/url-provenance.ts:288`) for addresses that pass `isBraveThumbnailUrl` (`:232`); every server-drawn `<img>` uses `use:replayEarlyImageEvent` (CSP; `tests/integration/server-drawn-image-events.test.ts`).
- Svelte 5 runes; icons from `@lucide/svelte` only; no inline `<svg>` in app code. Deliverable rows keep their place below the prose (F16).
- Each task's commit message ends with a trailer line `Tool-Rows-Task: <task id>` (for example `Tool-Rows-Task: A1`), then the `Co-Authored-By:` line.
- A task is done when its own tests pass, `npm run check` reports 0 errors and 0 warnings, and `npx biome check src scripts tests` is clean. Playwright and the full gate run once, at the end, by the orchestrator (one heavy job at a time on this Mac).

## Review Focus

1. **Rows saved before this change** (no `reasonCode`; failures as `status: "failed"` with `metadata.error`, as `status: "done"` with `ok: false` and English `outputSummary`, or as `tool_error` metadata `{ok:false, error, errorCode}`) must draw the tool's fallback sentence, never raw text, and never throw. Test: Task B3, "draws every tool's pre-change failure shapes with its fallback and no raw text".
2. **A turn stopped mid-step, then reloaded.** The step is saved as `running` (no closing event; `conversation-history.ts:93`). Once the reply is no longer streaming it must read as the quiet stop, not a spinner. Test: Task B3, "a running row of a finished reply reads as stopped", and the ThinkingBlock render test there.
3. **One account run with mixed outcomes** (one call failed, one worked; one call not connected, one worked). The row's glyph is the worst kind among its calls, each call keeps its own line, and a stop is never counted as a failure in the strip. Test: Task B5, "takes the worst kind among a run's calls".
4. **English placeholders from the server in a Hungarian chat.** Calendar's "(untitled event)", email's "(no subject)", photos' "(photo)" and location's "Location at <ISO time>" are model-facing candidate titles; the row must show localized words, and a time in the person's format. Test: Task B5, "localizes the server's placeholder titles".
5. **Counts of one and many in both languages** ("1 picture" / "5 pictures", "1 event" / "3 events"; Hungarian takes no plural branch: "5 kép"). Test: Task B4 and Task B5 count tests, each in `en` and `hu`.

---

## Tracks and coordination

Two native sessions, never more at once (the owner's limit). Each works in its own worktree on its own branch, created from `claude/tool-row-words` (which holds the spec and this plan):

- **Track A, the server** (Sonnet): branch `tool-rows/server`, tasks A1 to A8, in order. Owns `src/lib/shared/tool-reasons.ts`, everything under `src/lib/server/`, and `src/lib/server/services/AGENTS.md`.
- **Track B, the browser** (Opus): branch `tool-rows/browser`, tasks B1 to B8, in order. Owns `src/lib/utils/`, `src/lib/i18n/`, `src/lib/components/`, `tests/e2e/`, the root `AGENTS.md` and `src/lib/components/chat/AGENTS.md`.

Start: `git switch -c tool-rows/<server|browser> claude/tool-row-words` in the session's own worktree, after checking `git merge-base --is-ancestor 2fb86fdc1 claude/tool-row-words`. A worktree's empty `node_modules`: clone a sibling's with `cp -cR` when `package-lock.json` matches (project memory "Empty worktree node_modules").

Dependencies: B1 needs nothing. B2 needs A1: Track B merges `tool-rows/server` (`git merge`, never cherry-pick) as soon as a commit with `Tool-Rows-Task: A1` is on it, and again before B8. B3 to B7 test with synthetic segments, so they need no other A task. Neither track edits the other's files; a file a task needs from the other side is a message to the orchestrator.

Each track reports to the orchestrator after every task: the task id, its commit, tests run, and "N of 8 done" with its own ETA. The orchestrator relays a progress bar and an ETA (from `date`) to the owner.

End (orchestrator): merge both branches into `claude/tool-row-words`; one Opus review of the whole branch against the spec and this plan, with the Hungarian checked by a native-quality read; fix wave; then `scripts/gates.sh agent "$TMPDIR/tool-rows-gate" --port 4600 tests/e2e/chat-failed-tool-row.spec.ts tests/e2e/chat-one-card-per-item.spec.ts tests/e2e/images-pipeline.spec.ts tests/e2e/atlas-job-flow.spec.ts tests/e2e/files-strip.spec.ts tests/e2e/chat.spec.ts tests/e2e/streaming.spec.ts tests/e2e/conversation.spec.ts`.

---

## Track A: the server

### Task A1: The contract

**Files:**
- Create: `src/lib/shared/tool-reasons.ts`
- Test: `src/lib/shared/tool-reasons.test.ts`
- Modify: `src/lib/server/services/normal-chat-tools/shared.ts` (add the WeakMap pair next to `withToolExecutionFact`, :167-180)
- Modify: `src/lib/server/services/normal-chat-tools/make-image.ts` (:143-147, :185-196), `make-video.ts` (:134-181), `suggest-instruction.ts` (:46-49), `src/lib/server/services/atlas/config.ts` (:29): derive their code unions from the shared lists, no behaviour change
- Modify: `normal-chat-tools/calendar.ts`, `email.ts`, `photos.ts`, `location.ts`: replace the placeholder title literals with the shared constants (same strings)

**Interfaces:**
- Produces, in `src/lib/shared/tool-reasons.ts` (pure, no imports from `$lib/server`):
  - `REASON_CODE_KEY = "reasonCode"`, `DISPLAY_OUTPUT_KEY = "displayOutput"`, `REASON_PLACE_KEY = "reasonPlace"`
  - `SHARED_REASON_CODES = ["stopped", "timed_out", "out_of_time"] as const`; `type SharedReasonCode`
  - `CONNECTOR_TOOL_NAMES = ["calendar", "contacts", "email", "files", "location", "media", "photos", "repos", "tasks"] as const`
  - `CONNECTOR_REASON_CODES = ["not_connected", "needs_reconnect", "no_such_account", "account_unreachable", "writes_turned_off", "read_only_account", "item_not_found", "too_large", "not_supported", "not_set_up", "request_adjusted", "details_kept_local", "details_withheld"] as const` (`details_kept_local`: the cloud model got a local summary, `metadata.localDistilled`; `details_withheld`: it got nothing, the "details were withheld" successes)
  - `TOOL_REASON_CODES` (`as const satisfies Record<string, readonly string[]>`), exactly:
    - `research_web`: `search_unavailable`, `nothing_found`, `reading_budget_used`
    - `fetch_url`: `link_not_from_a_source`, `reading_budget_used`, `read_unavailable`, `site_timeout`, `site_refused`, `page_not_found`, `no_readable_text`
    - `image_search`: `search_unavailable`, `not_set_up`, `nothing_found`
    - `memory_context`: `chat_out_of_reach`, `nothing_found`, `memory_off`, `memory_unavailable`
    - each name in `CONNECTOR_TOOL_NAMES`: `CONNECTOR_REASON_CODES`
    - `run_python`: `program_error`, `sandbox_unavailable`
    - `map_route`: `not_set_up`, `place_not_found`, `out_of_coverage`, `no_route`, `region_preparing`, `multi_region`, `region_unavailable`, `transit_unavailable`, `geocoder_unavailable`, `route_service_unavailable`, `request_adjusted`
    - `use_skill`: `skill_not_found`, `skill_turned_off`
    - `suggest_instruction`: `already_offered`, `empty_text`, `text_too_long`
    - `read_artifact`: `item_not_found`, `request_adjusted`
    - `read_generated_file`: `file_not_found`, `ambiguous`, `request_adjusted`
    - `create_artifact`: `reply_limit_reached`, `kind_not_creatable`, `too_large`, `request_adjusted`
    - `edit_artifact`: `request_adjusted`, `item_not_found`, `not_editable_as_text`, `kind_not_editable`, `rebuild_limit_reached`, `changed_since_read`
  - `IMAGE_REFUSAL_CODES` = today's `imageRefusal` values (unknown_picture, too_many_pictures, too_many_takes, too_many_calls, retry_unknown, retry_twice, transparent_unavailable, not_configured, explicit_request); `IMAGE_ERROR_CODES` = today's `imageError` values (the FAILURE_MESSAGES keys at make-image.ts:185-196, plus `image_worker_lost`, `image_take_missing`, `image_tool_timeout`, `image_error`)
  - `IMAGE_DERIVED_CODES = ["image_unreadable"] as const` (read from `metadata.imageUnreadable === true`, `tool-activity.ts:485`)
  - `VIDEO_ERROR_CODES` = today's `videoError` values (refusals not_configured, not_asked_for, explicit_request, unknown_picture, video_error; the take codes at make-video.ts:164-181; plus `video_worker_lost`, `video_tool_timeout`). A Stop is `videoStopped: true` / `imageStopped: true`, never a `videoError` or `imageError` value (make-video.ts:704-706, make-image.ts:689-691); it reads as the shared `stopped`.
  - `ATLAS_ERROR_CODES` = `atlas_pipeline_failed`, `atlas_v3_local_source_unavailable`, `atlas_v3_no_evidence`, `atlas_v3_no_verdict`, `atlas_v3_no_sections`, `atlas_worker_heartbeat_timeout`, `no_verdict`, `job_failed`, `cancelled`, and the legacy stored `research_failed`, `atlas_quality_gate_failed`
  - `type ToolWithReasons = keyof typeof TOOL_REASON_CODES`; `type ToolReasonCode<T extends ToolWithReasons> = (typeof TOOL_REASON_CODES)[T][number] | SharedReasonCode`
  - `CONNECTOR_PLACEHOLDER_TITLES = { untitledEvent: "(untitled event)", noSubject: "(no subject)", photo: "(photo)" } as const`, `LOCATION_AT_PREFIX = "Location at "`
  - `DISPLAY_OUTPUT_MAX_LINES = 12`, `DISPLAY_OUTPUT_MAX_CHARS = 600`
- Produces, in `normal-chat-tools/shared.ts`: `withReasonCode<T extends object>(payload: T, code: string): T` and `reasonCodeOf(payload: unknown): string | undefined`.
- Fallow's baseline has no unused exports: every export of `tool-reasons.ts` must have an importer by the end of the build (each is used by a later task here; the key constants replace their string literals at the use sites), and one that ends unused is removed.

- [ ] **Step 1: Write the failing tests** in `src/lib/shared/tool-reasons.test.ts`: "every code is snake_case" (`/^[a-z][a-z0-9_]*$/` over every list), "no tool lists a code twice", "no tool list repeats a shared code", "the connector tools share one list", and in `shared.test.ts` "a tagged payload serializes exactly as before and gives its code back" (`JSON.stringify(withReasonCode(p, "x")) === JSON.stringify(p)`, `reasonCodeOf(p) === "x"`, `reasonCodeOf({}) === undefined`).
- [ ] **Step 2: Run** `npx vitest run src/lib/shared/tool-reasons.test.ts src/lib/server/services/normal-chat-tools/shared.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Create the module and the WeakMap pair**; derive `make-image.ts`'s, `make-video.ts`'s, `suggest-instruction.ts`'s and Atlas's code unions from the shared lists (`type X = (typeof LIST)[number]`), and use the placeholder constants in the four connector modules.
- [ ] **Step 4: Run** the tests above plus `npx vitest run src/lib/server/services/normal-chat-tools/make-image.test.ts src/lib/server/services/normal-chat-tools/make-video.test.ts src/lib/server/services/normal-chat-tools/index.test.ts -t "catalogue"`. Expected: PASS, catalogue snapshot unchanged.
- [ ] **Step 5: Commit** (`feat(tools): one closed list of reason codes per tool`, trailer `Tool-Rows-Task: A1`).

### Task A2: The envelope's shared codes and the failure log

**Files:**
- Modify: `src/lib/server/services/normal-chat-tools/shared.ts` (catch 706-769; `commit` 553-611)
- Modify: `src/lib/server/services/chat-turn/stream-orchestrator.ts` (`tool_error` branch 1307-1345)
- Modify: `src/lib/server/services/AGENTS.md` ("Tool execution envelope note")
- Test: `normal-chat-tools/shared.test.ts`, `chat-turn/stream-orchestrator.test.ts`

**Interfaces:**
- Consumes: A1's `SharedReasonCode`, `REASON_CODE_KEY`.
- Produces: `sharedReasonFor(error: unknown, signal: AbortSignal | undefined): SharedReasonCode | null` in `shared.ts`: `"stopped"` when `signal?.aborted` and `signal.reason instanceof UserStopReason` (`chat-turn/active-streams.ts:486`); `"out_of_time"` when `abortedByTurnDeadline(signal)`; `"timed_out"` when `isToolTimeoutError(error)`; else `null`. Every recorded entry of a thrown error carries `metadata.reasonCode`, by this precedence: `stopped` and `out_of_time` override any code the tool's `onError` set (a Stop must never fall to a tool's catch-all, such as memory_context's `memory_unavailable`); a tool's own code beats `timed_out`; otherwise the shared one. On the grant path (`research_web`, `fetch_url`) `commit` takes an optional `reasonCode` and writes it into the metadata it rebuilds (577-600).
- `tool_error` (`stream-orchestrator.ts:1307-1345`): `errorCode` is `classifyStreamError`'s bucket, which files any message containing "abort" under `"timeout"` (`chat-turn/stream.ts:1320-1332`), so it is not used. The code comes from the event's error message instead: `isToolTimeoutError` gives `timed_out`; the completion wrapper's `user_stop` gives `stopped` and its `deadline` gives `out_of_time` (`normal-chat-model/completion-tools.ts:201-207, 288`; `completion.ts:215-218`); anything else gives no code.
- The failure log is written in the envelope's catch for a thrown error (the error is only in scope there; `withUrlProvenance`, `normal-chat-tools/url-provenance.ts:28-41`, forwards only the entry) and in the recorder's `record` for an in-band failure (`metadata.ok === false`, no throw), once per call.

- [ ] **Step 1: Write the failing tests** in `shared.test.ts`, describe "reason codes": "a call the person stopped records stopped", "a call past its own timeout records timed_out", "a call cut by the working deadline records out_of_time", "a Stop overrides the tool's own code" (an `onError` that sets `memory_unavailable`, aborted with `UserStopReason`, records `stopped`), "a tool's own code wins over timed_out", "the grant path keeps the reason code it was given", "a thrown failure is logged once, redacted" (spy on `console.warn`; exactly one call; it contains `tool=`, `code=` and the error class; a message carrying `https://example.com/x` and `"RAW-SENTINEL-7f3a"` logs `<url>` and `<text>` and neither original; the call's input and `outputSummary` sentinels are absent), "an in-band failure (ok:false, no throw) is logged once with its code and no message". In `stream-orchestrator.test.ts` (next to 2603-2680): "a tool_error whose message is a tool timeout carries timed_out", "… user_stop carries stopped", "… deadline carries out_of_time", "a tool_error filed under timeout for an abort carries no timed_out".
- [ ] **Step 2: Run** `npx vitest run src/lib/server/services/normal-chat-tools/shared.test.ts src/lib/server/services/chat-turn/stream-orchestrator.test.ts`. Expected: FAIL on the new tests.
- [ ] **Step 3: Implement** `sharedReasonFor`, the code and its precedence on recorded thrown errors, `commit`'s `reasonCode`, the `tool_error` mapping from the event's error message, and the log (catch for thrown errors, `record` for in-band failures; a WeakSet of logged entries keeps it to one line per call). Add to the AGENTS.md envelope note: every failure or refusal a tool records carries `metadata.reasonCode` from its closed list in `src/lib/shared/tool-reasons.ts`, in-band codes ride `withReasonCode`, the model-facing text stays the model's, and the raw cause is logged once, content-free.
- [ ] **Step 4: Run** the same tests. Expected: PASS. Then `npx vitest run src/lib/server/services/normal-chat-tools/ src/lib/server/services/chat-turn/stream-orchestrator.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** (`feat(tools): name a stop, a timeout and the deadline on every tool, and log failures once`, trailer `Tool-Rows-Task: A2`).

### Task A3: The web reads

**Files:**
- Modify: `normal-chat-tools/research-web-tool.ts` (run 250-267, onError 269-295), `src/lib/server/services/web-grounding.ts` (success=false 470-474), `normal-chat-tools/index.ts` (fetch_url 819-1016, image_search 1099-1173), `src/lib/server/services/parallel-search/fetch-url.ts` (125-145, 286-289), `parallel-search/client.ts` (`ParallelExtractUrlError` 82, extract failure 284), `src/lib/server/services/image-search.ts` (25, 43-45)
- Test: `normal-chat-tools/index.test.ts` (existing web describes), `parallel-search/fetch-url.test.ts`, `normal-chat-tools/research-web-tool.test.ts` (create beside the tool if absent)

**Interfaces:**
- Consumes: A1 codes, A2 `commit(..., reasonCode)`, `withReasonCode`.
- Produces on segments:
  - research_web: a thrown "Parallel search failed" gives `search_unavailable`; the grant refusal ("Web read capacity exhausted") gives `reading_budget_used`; a result with no usable source or evidence gives `nothing_found`.
  - fetch_url: `FetchUrlRefusedError` gives `link_not_from_a_source`; the grant refusal gives `reasonCode: "reading_budget_used"`; a thrown "Parallel extract failed" gives `read_unavailable`. Today `parseExtractErrors` (`parallel-search/client.ts:200-229`) keeps only each error's free text (`ParallelExtractUrlError` is `{url, reason}`) and drops the status the raw error object carries (`client.test.ts:404` passes `status: 500`). Add optional `status?: number` and `errorType?: string` to `ParallelExtractUrlError`, kept from the raw object, and leave the brief's text byte-identical (the kept fields never enter the model payload). When no requested page came back, the first such error maps: 401, 403 or 451 to `site_refused`; 404 or 410 to `page_not_found`; an `errorType` naming a timeout, or 408 or 504, to `site_timeout`; anything else to no code. `no_readable_text` is a call whose results came back but whose every `full_content` and excerpt is empty. A partial success carries no code.
  - image_search: "BRAVE_SEARCH_API_KEY is not configured" gives `not_set_up`; "Brave Search API error" gives `search_unavailable`; zero results stay a success with `reasonCode: "nothing_found"`.

- [ ] **Step 1: Write the failing tests**, one per mapping above, each asserting `entry.metadata.reasonCode` and that the model payload and `outputSummary` equal today's (compare against the pre-change value captured in the test).
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the mappings at the sites listed.
- [ ] **Step 4: Run** them, then `npx vitest run src/lib/server/services/normal-chat-tools/ src/lib/server/services/parallel-search/`. Expected: PASS, catalogue snapshot unchanged.
- [ ] **Step 5: Commit** (`feat(tools): the web reads name their failures`, trailer `Tool-Rows-Task: A3`).

### Task A4: Memory

**Files:**
- Modify: `normal-chat-tools/index.ts` (memory_context 1019-1098), `normal-chat-tools/memory-context.ts` (~165-275), `src/lib/server/services/memory-context.ts` (33-50, the inert result), `memory-context/history.ts` (307, 504, 558), `memory-context/persona.ts` (182-196)
- Test: `src/lib/server/services/memory-context.test.ts`, `normal-chat-tools/index.test.ts` (memory_context, ~6395)

**Interfaces:**
- Produces: the scope `ToolCallRefusedError` gives `chat_out_of_reach`; the inert result because memory is off for the person gives `memory_off`; persona `status: "empty"`, history `"empty"` and project `hasProjectContext: false` give `nothing_found`; persona `status: "error"`, a bad mode and any other thrown error give `memory_unavailable` (an abort is A2's: a Stop or the deadline overrides this code). `metadata.mode` stays as today (the browser reads it to say "past chats").

- [ ] **Step 1: Write the failing tests**, one per mapping, with the payload unchanged.
- [ ] **Step 2: Run** `npx vitest run src/lib/server/services/memory-context.test.ts src/lib/server/services/normal-chat-tools/index.test.ts -t memory`. Expected: FAIL.
- [ ] **Step 3: Implement** (the inert result needs a way to say "off" that is not a payload field: tag it with `withReasonCode`).
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** (`feat(tools): memory lookups name their outcomes`, trailer `Tool-Rows-Task: A4`).

### Task A5: The nine account tools

**Files:**
- Modify: `normal-chat-tools/calendar.ts`, `email.ts`, `files.ts`, `photos.ts`, `media.ts`, `location.ts`, `contacts.ts`, `repos.ts`, `tasks.ts` (every failure return listed in "Interfaces"), `normal-chat-tools/shared.ts` (no-match helper 66-75), `normal-chat-tools/index.ts` (the nine entries, 2072-2972: add `reasonCode: reasonCodeOf(modelPayload)` to each entry's metadata)
- Test: `normal-chat-tools/index.test.ts` (the "degrades gracefully" describes, 4029-4712)

**Interfaces:**
- Produces (tagged with `withReasonCode`; the message text stays as it is):
  - each tool's not-connected message (calendar 1435, email 953, files 1381, photos 800, media 469, location 490, repos 613, contacts 346, tasks 320) and `connection_not_found`: `not_connected`
  - the no-match helper (shared.ts 66-75) and repos' own (776-781): `no_such_account`
  - each `mapAdapterError` (calendar 295-331, email ~256-270, files ~530-573, photos ~298-310, media ~219-231, location ~205-215, repos ~148-162, tasks ~132-144; contacts' catches 253 and 297) returns a string today, which a WeakMap cannot tag: it returns `{ message: string; code: ConnectorReasonCode }` instead, its callers put `message` in the payload exactly as before and tag the payload with `code`. Mapping: `needs_reauth` and `invalid_grant` to `needs_reconnect`; `message_not_found` and `not_found` to `item_not_found`; `too_large` to `too_large`; `invalid_path` to `request_adjusted`; `invalid_config` and `not_configured` to `not_set_up`; the default to `account_unreachable`
  - "Writing to X is turned off" (calendar 1363, email 885, files 843/950/1058/1147/1243, photos 722): `writes_turned_off`
  - OneDrive read-only (files 1400), calendar without write scope (1375): `read_only_account`
  - every missing-parameter message (calendar 794/865/1066/1144; email 529/720/801/1009/1053; files 851/958/965/1066/1155/1251/1481/1516; photos 711/861/963; repos 638/659/667): `request_adjusted`
  - calendar event not found (887/1162): `item_not_found`; Apple refusals (1048/1173/1192/1206) and availability unsupported (1523): `not_supported`; location without a home (625): `not_set_up`
  - each "details withheld" success (calendar 679/1003/1312, contacts 199, email 481/602/702, files 1364, location 465, media 412, photos 512, repos 389-592, tasks 206), where the cloud model got nothing: `details_withheld`; a call the envelope summarised locally (`metadata.localDistilled: true`) needs no tag (the browser reads that flag as `details_kept_local`)

- [ ] **Step 1: Write the failing tests**: for each tool, its not-connected, no-match, an adapter error and (where it has one) a writes-off case carry the expected code; a "details withheld" success carries `details_withheld`; for one case per tool the model payload is byte-identical to today's.
- [ ] **Step 2: Run** `npx vitest run src/lib/server/services/normal-chat-tools/index.test.ts -t "degrades gracefully"`. Expected: FAIL.
- [ ] **Step 3: Implement** the tags and the nine entry reads.
- [ ] **Step 4: Run** the same, then `npx vitest run src/lib/server/services/normal-chat-tools/`. Expected: PASS.
- [ ] **Step 5: Commit** (`feat(connections): account tools name their failures`, trailer `Tool-Rows-Task: A5`).

### Task A6: Python

**Files:**
- Modify: `normal-chat-tools/index.ts` (run_python 1642-1718), `normal-chat-tools/run-python.ts` (add the display copy helper)
- Test: `normal-chat-tools/index.test.ts` (run_python, 2018-2105), `normal-chat-tools/run-python.test.ts`

**Interfaces:**
- Produces: `displayOutputOf(stdout: string): string | null` in `run-python.ts`: the first `DISPLAY_OUTPUT_MAX_LINES` lines of the raw stdout, cut at the last whole line within `DISPLAY_OUTPUT_MAX_CHARS`; when the first line alone is longer than that, it is hard-cut to `DISPLAY_OUTPUT_MAX_CHARS - 1` characters plus "…"; trailing whitespace trimmed; `null` for empty output. The success entry's metadata gains `displayOutput` (when not null). Codes: `timedOut` gives `timed_out`; `exitCode === -1` without `timedOut` gives `sandbox_unavailable`; "Execution cancelled" gives `stopped`; an exit code above 0 gives `program_error`. `ok` stays as today (true on this path).

- [ ] **Step 1: Write the failing tests**: `displayOutputOf` with 20 lines gives 12; with a 2,000-character single line gives exactly 600 characters ending in "…"; with "" gives `null`; the entry of `print("hi")` has `displayOutput: "hi"` and an unchanged model payload; one test per code.
- [ ] **Step 2: Run** `npx vitest run src/lib/server/services/normal-chat-tools/run-python.test.ts src/lib/server/services/normal-chat-tools/index.test.ts -t run_python`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** (`feat(tools): keep a short copy of what Python printed, for the row`, trailer `Tool-Rows-Task: A6`).

### Task A7: Routes, skills, suggestions and the two read tools

**Files:**
- Modify: `normal-chat-tools/routing.ts` (492-524 and callers 987, 1149, 1209, 1319; place resolution 549-603; geocode 914-940; `UNCONFIGURED_MESSAGE` 485), `normal-chat-tools/index.ts` (map_route entry 3100-3106; use_skill 3148-3260; suggest_instruction 3270-3400; read_generated_file 1719-1815; read_artifact 1925-1981), `normal-chat-tools/read-generated-file.ts` (2470-2499), `normal-chat-tools/artifact-tools/read.ts` (273-285)
- Test: `normal-chat-tools/routing.test.ts` ("coverage-aware failures", 498), `normal-chat-tools/index.test.ts` (use_skill 6493, suggest_instruction 6584-6727, read_generated_file 6249-6386), `artifact-tools/read.test.ts`

**Interfaces:**
- Produces:
  - map_route: `RoutingFailureReason` (`routing/types.ts:209-236`) carried as the code: `unconfigured` and `geocoder_unconfigured` to `not_set_up`; `not_found` to `place_not_found` plus `metadata.reasonPlace` = the input place text that did not resolve; `out_of_coverage`, `no_route`, `region_preparing`, `multi_region`, `region_unavailable`, `transit_unavailable` keep their names; `provider_error` to `route_service_unavailable`. Place resolution tells the geocoder being down apart (`routing.ts:587`, `:935`) but `ResolveResult` (`:545`) carries no reason: add one, so that case gives `geocoder_unavailable`. A missing origin or destination (`missingInput`, `:916`) gives `request_adjusted`.
  - use_skill: `SkillLookupFailureReason` `not_found` to `skill_not_found`, `disabled` to `skill_turned_off`.
  - suggest_instruction: the refusal's existing `reason` also as `reasonCode`; `onError` carries no code.
  - read_generated_file: not found `file_not_found`, ambiguous `ambiguous`; a schema failure (today it records no entry, 1732-1739) records an entry with `status: "done"`, no `outputSummary`, no `resultDigest`, no candidates and metadata `{ok: false, reasonCode: "request_adjusted"}` (Global Constraints: the digest stays "Completed.").
  - read_artifact: not found `item_not_found`.

- [ ] **Step 1: Write the failing tests**, one per mapping, payloads unchanged; and "a schema failure's new entry keeps the history digest" (`buildHistoryToolDigest` of the segment built from it equals the digest of today's entry-less segment: summary "Completed.", `ok` true).
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them, then `npx vitest run src/lib/server/services/normal-chat-tools/ src/lib/server/services/chat-turn/conversation-history.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** (`feat(tools): routes, skills, suggestions and reads name their outcomes`, trailer `Tool-Rows-Task: A7`).

### Task A8: Creating and changing items

**Files:**
- Modify: `normal-chat-tools/index.ts` (create_artifact 1823-1870, edit_artifact 1982-2010), `normal-chat-tools/artifact-tools/create.ts` (~311-346), `artifact-tools/edit.ts` (650-933)
- Test: `artifact-tools/create.test.ts`, `artifact-tools/edit.test.ts` (161, 357, 480), `normal-chat-tools/index.test.ts` (create cap 5263)

**Interfaces:**
- Produces:
  - create_artifact: the per-turn cap (1852-1867) `reply_limit_reached`; no handler for the kind `kind_not_creatable`; a schema failure (1838-1845, no entry today) records an entry shaped as in A7 (`status: "done"`, no `outputSummary`, `request_adjusted`); the handlers' own refusals (`create.ts:190-279`): an HTML brief and an unreadable board `request_adjusted`, too large `too_large`, any other no code (the browser's fallback); "The request was cancelled." (`create.ts:147, 234, 264`) `stopped`.
  - edit_artifact: patches with ops (688), the instruction mix (696), nothing sent (705), an instruction for something that is not an App (789-806), a schema failure (2004-2008, recorded as for create) and the handlers' shape refusals (the Document handler's "Documents use patches, not ops." and malformed patch ops, `edit.ts:333-339`, where malformed patches go by design, `index.ts:1985-1994`; the same kind of refusal in the Canvas and App handlers) `request_adjusted`; "The request was cancelled." (`edit.ts:330, 370, 419, 464, 516`) `stopped`; not found (650-669) `item_not_found`; a File, picture or video (730-787) `not_editable_as_text`; no handler (808-825) `kind_not_editable`; the App rebuild limit (524-529) `rebuild_limit_reached`; a call whose every operation was refused for staleness (Document `block_changed`, Board `stale`, Canvas `version_conflict` after its retry) `changed_since_read`. `refusedBlocksJson` stays as it is.

- [ ] **Step 1: Write the failing tests**, one per mapping, payloads unchanged, plus the A7-style digest test for each schema failure's new entry.
- [ ] **Step 2: Run** `npx vitest run src/lib/server/services/normal-chat-tools/artifact-tools/ src/lib/server/services/normal-chat-tools/index.test.ts -t artifact`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same, then `npx vitest run src/lib/server/services/normal-chat-tools/`. Expected: PASS.
- [ ] **Step 5: Commit** (`feat(artifacts): create and edit name their refusals`, trailer `Tool-Rows-Task: A8`).

---

## Track B: the browser

### Task B1: Take out the dumps

**Files:**
- Delete: `src/lib/components/chat/tool-call-summary.ts`, `tool-call-summary.test.ts`
- Modify: `src/lib/components/chat/ToolActivityRow.svelte` (480-527 summary state; 761-773 the two sentences; 851-861 error Details; 862-883 generic Details; the `.act-summary*`, `.act-details*` and `.act-kv*` styles)
- Modify: `src/lib/utils/tool-activity.ts`: delete `genericBody` (631) and every `genericBody(...)` use (a row with nothing better has no body); delete `toolFailureReason` (493) and the raw error body in `buildToolActivityItem` (655-672: keep the "Failed" meta, no body for now); delete `toolElapsedLabel` (390) and the nine `elapsed` metas (997, 1026, 1057, 1081, 1117, 1150, 1360, 1384, 1396); drop the meta "Details" (`toolActivity.failureDetails`) from the picture, clip, create and edit failure rows (779, 924, 1332)
- Modify: `src/lib/i18n/chat.ts`: delete the `chat.toolSummary.*` keys (EN 358-369, HU 1634-1644) and `toolActivity.failureDetails` (EN 1122, HU 2376), and their entries in `TOOL_ACTIVITY_I18N_KEYS`
- Test: `src/lib/utils/tool-activity.test.ts`, `src/lib/components/chat/ToolActivityRow.test.ts`, `ThinkingBlock.test.ts`

**Interfaces:**
- Produces: `ToolActivityBody` without `generic` and `error`; `ToolActivityRow` without summary or Details markup.

- [ ] **Step 1: Write the failing tests**: in `tool-activity.test.ts`, "no row carries an elapsed time" (a segment with `metadata.durationMs: 1400` for every row builder gives no meta matching `/\d(\.\d)? ?(ms|s)$/`), "an unknown tool's row has no body" (verb "Tool" stays until B4), "a failed fetch_url row has meta Failed and no body"; in `ToolActivityRow.test.ts`, "an opened row shows no summary sentences and no Details" (no `tool-activity-summary-text`, `tool-activity-details`, `tool-activity-error` test ids).
- [ ] **Step 2: Run** `npx vitest run src/lib/utils/tool-activity.test.ts src/lib/components/chat/ToolActivityRow.test.ts`. Expected: FAIL on the new tests.
- [ ] **Step 3: Implement the removals**, and update or delete the tests that pinned the removed behaviour (tool-activity.test.ts 549, 569, 580, 601, 610, 1525-1720 meta "Details"; ToolActivityRow.test.ts 81, 338, 382, 393, 421, 432, 443, 463, 486, 989).
- [ ] **Step 4: Run** `npx vitest run src/lib/utils/ src/lib/components/chat/ src/lib/i18n/`. Expected: PASS.
- [ ] **Step 5: Commit** (`refactor(chat): tool rows stop dumping the call`, trailer `Tool-Rows-Task: B1`).

### Task B2: The words and the registry

Merge `tool-rows/server` first (it must contain `Tool-Rows-Task: A1`).

**Files:**
- Create: `src/lib/i18n/tool-rows.ts` (`toolRowsDict`, `{ en: {...}, hu: {...} } as const`)
- Modify: `src/lib/i18n/index.ts` (import 3-14, spread into `.en` 48-61 and `.hu` 62-75), `AUDITED_PREFIXES` in `src/lib/i18n.test-helpers.ts:7` (add `"toolRows."`), the param-parity list in `src/lib/i18n.test.ts` (~249-259, add `toolRowsDict`)
- Create: `src/lib/utils/tool-reason-words.ts`
- Test: `src/lib/utils/tool-reason-words.test.ts`

**Interfaces:**
- Consumes: A1's lists and types.
- Produces, in `tool-reason-words.ts`:
  - `type ReasonKind = "fail" | "stop" | "info" | "empty"` (fail: ✕ red, the row's shown status `failed`; stop: the quiet –, shown status `skipped`; info: ✓ with a line; empty: ✓ with meta "nothing found" and no body)
  - `type ReasonWords = { kind: ReasonKind; key: I18nKey | null }` (`key: null` when the row's own verb says it all and the row has no body)
  - `TOOL_REASON_WORDS`: for each `ToolWithReasons` a `{ codes: Record<(typeof TOOL_REASON_CODES)[T][number], ReasonWords> & Partial<Record<SharedReasonCode, ReasonWords>>; fallback: I18nKey }`, and the same shape for `make_image` (over `IMAGE_REFUSAL_CODES`, `IMAGE_ERROR_CODES` and `IMAGE_DERIVED_CODES`), `make_video` (over `VIDEO_ERROR_CODES`), `atlas` (over `ATLAS_ERROR_CODES`) and `produce_file` (`codes: {}`, fallback `fileProduction.failedDescription`: its codes are worded by the file card's own map, Task B7). The `Record` types make a missing tool code a compile error; the shared codes are listed only by a tool that words them itself: `image_search` and `fetch_url` word `timed_out` with the spec's "didn't answer in time" sentences, `run_python` with its own `timed_out` row.
  - `readReasonCode(toolName: string, metadata: Record<string, string | number | boolean | null> | undefined): string | null`: `metadata.reasonCode`; for make_image `"stopped"` when `imageStopped === true`, else `"image_unreadable"` when `imageUnreadable === true`, else `imageRefusal`, else `imageError`; for make_video `"stopped"` when `videoStopped === true`, else `videoError`; for suggest_instruction `reason`; for a connector with `localDistilled === true` and no code, `"details_kept_local"`. A stored `errorCode` (`"timeout"` and the rest) is never read: it is the stream's bucket, not a cause, so an older `tool_error` row gets its tool's fallback.
  - `resolveToolReason(toolName: string, code: string | null): { code: string | null; kind: ReasonKind; key: I18nKey | null }`: a known code gives its words; a shared code the tool does not word itself gives the shared words; an unknown or missing code on a failure gives `{ kind: "fail", key: <the tool's fallback> }`. Tools outside the registry (any future tool) get a generic fallback key `toolRows.generic.fallback`.
- Words: the spec's section 5 tables verbatim, under `toolRows.<tool>.<code>`, `toolRows.<tool>.fallback` and `toolRows.shared.<code>`. Reuse existing keys where the spec says "unchanged" (`toolActivity.pictureReason.*`, `artifacts.video.card.*`, `atlas.failed`). Plus these, decided by the plan:

| Key | Kind | English | Hungarian |
|---|---|---|---|
| `toolRows.image_search.not_set_up` | stop | The picture search isn't set up yet. | A képkeresés még nincs beállítva. |
| `toolRows.fetch_url.read_unavailable` | fail | The page reader didn't answer, so nothing was read. | Az oldalolvasó nem válaszolt, ezért semmit nem olvasott el. |
| `toolRows.memory_context.memory_off` | stop | Memory is turned off, so Alfy didn't look. | Az emlékezés ki van kapcsolva, ezért Alfy nem nézett utána. |
| `toolRows.connector.<tool>.read_only_account` | stop | (Calendar) This calendar can only be read, not changed. | Ez a naptár csak olvasható, nem módosítható. |
| `toolRows.connector.<tool>.item_not_found` | fail | (Calendar) Alfy couldn't find that event. | Alfy nem találta ezt az eseményt. |
| `toolRows.connector.<tool>.too_large` | stop | (Files) That file is too large to open here. | Ez a fájl túl nagy ahhoz, hogy itt megnyíljon. |
| `toolRows.connector.<tool>.not_supported` | stop | (Calendar) This calendar can't do that. | Ez a naptár erre nem képes. |
| `toolRows.connector.<tool>.not_set_up` | stop | (Location) Your home isn't set yet. | Az otthonod még nincs megadva. |
| `toolRows.map_route.not_set_up` | stop | Route planning isn't set up yet. | Az útvonaltervezés még nincs beállítva. |
| `toolRows.map_route.route_service_unavailable` | fail | The route service didn't answer. | Az útvonaltervező nem válaszolt. |
| `toolRows.atlas.atlas_v3_local_source_unavailable` | fail | Atlas couldn't reach a source it needed. | Az Atlas nem érte el az egyik szükséges forrást. |
| `toolRows.atlas.atlas_v3_no_evidence` | stop | Atlas found nothing it could rely on for this question. | Az Atlas nem talált erre a kérdésre megbízható forrást. |
| `toolRows.atlas.atlas_v3_no_verdict` (also `no_verdict`) | fail | Atlas couldn't reach a conclusion. | Az Atlas nem jutott következtetésre. |
| `toolRows.atlas.atlas_v3_no_sections` | fail | Atlas couldn't write the report. | Az Atlas nem tudta megírni a jelentést. |
| `toolRows.generic.fallback` | fail | This step couldn't be finished. | Ezt a lépést nem sikerült befejezni. |
| `toolRows.shared.request_adjusted` | stop | Alfy adjusted its request. | Alfy pontosította a kérést. |
| `toolRows.create_artifact.too_large` | stop | That's too large to make as one item. | Ez túl nagy ahhoz, hogy egy elemként elkészüljön. |
| `toolRows.connector.details_withheld` | info | To keep them private, the cloud model wasn't given these details. | Az adatvédelem miatt a felhős modell nem kapta meg ezeket a részleteket. |
| `toolRows.map_route.geocoder_unavailable` | fail | (the spec's) The map search didn't answer. | A térképes kereső nem válaszolt. |

  The spec's Atlas row for `worker_queue_timeout` is dropped: Atlas cannot end with that code (only file production passes `queuedOlderThan`, `file-production/production-job.ts:458`).

  The nine account tools each get their own sentences in the pattern of the spec's Calendar table, written out in full in both languages (Hungarian nouns: naptár, levelezés, fájlok, fotók, média, helyzet, névjegyek, kód, teendők); `request_adjusted` and `details_kept_local` are shared across the nine (`toolRows.connector.request_adjusted`, `toolRows.connector.details_kept_local`). Atlas `cancelled` keeps the existing cancelled state and is not a failure word. `request_adjusted` takes `toolRows.shared.request_adjusted` everywhere except create_artifact and edit_artifact, whose rows say it in the verb (`key: null`, Task B4). The picture row keeps its three special states, by code: the model-correction refusals `unknown_picture`, `too_many_pictures`, `too_many_takes`, `too_many_calls`, `retry_unknown`, `retry_twice` are a stop with `key: null` (the row's "Adjusting the picture request", no body; today a ✓, now the quiet –); `image_tool_timeout` and `video_tool_timeout` are info with `key: null` (the rows' "still being made", ✓, no body, as today); `image_unreadable` is a fail with `toolActivity.pictureReason.unreadable`. Kinds by code where the spec gives none: `request_adjusted`, `ambiguous`, `already_offered`, `empty_text`, `text_too_long`, `writes_turned_off`, `read_only_account`, `not_supported`, `not_set_up`, `no_such_account`, `not_connected`, `skill_turned_off`, `skill_not_found`, `memory_off`, `chat_out_of_reach`, `link_not_from_a_source`, `reading_budget_used`, `reply_limit_reached`, `kind_not_creatable`, `kind_not_editable`, `not_editable_as_text`, `rebuild_limit_reached`, `changed_since_read`, the picture and clip stops, `image_blocked`, `video_blocked`, `too_large`, `stopped`, `out_of_time` are stop; `nothing_found` is empty; `details_kept_local` and `details_withheld` are info; every other code is fail.

- [ ] **Step 1: Write the failing tests** in `tool-reason-words.test.ts`: "every key resolves in English and Hungarian" (each registry key and fallback is in the merged `en` and `hu` dictionaries with a non-empty value); "every tool in the model's catalogue has a fallback" (parse the tool names from `tool-catalogue.en.snapshot.txt`, ask_user excepted); "an unknown code is the tool's fallback, as a failure"; "a shared code uses the tool's own words when it has them" (`image_search` + `timed_out`); "readReasonCode reads the older keys" (imageStopped and videoStopped give `stopped`, imageUnreadable, imageRefusal, imageError, videoError, suggest `reason`, `localDistilled`; a stored `errorCode: "timeout"` gives `null`); "the file maker's every code has words" (scan `src/lib/server/services/file-production/**/*.ts` and `normal-chat-tools/produce-file.ts` for code literals in `code: "..."` and error constructors; the scan must find at least every code listed in Task B7, and each found code must be in `FileProductionCard`'s map, so mark this test `.todo` until B7 and make it real there).
- [ ] **Step 2: Run** `npx vitest run src/lib/utils/tool-reason-words.test.ts src/lib/i18n/`. Expected: FAIL.
- [ ] **Step 3: Write `tool-rows.ts` and the registry**, register the module.
- [ ] **Step 4: Run** the same. Expected: PASS (the file-maker test todo).
- [ ] **Step 5: Commit** (`feat(chat): one registry of friendly words for every tool outcome`, trailer `Tool-Rows-Task: B2`).

### Task B3: Rows read their reason

**Files:**
- Modify: `src/lib/utils/tool-activity.ts` (`buildToolActivityItem` 647-673, `ToolActivityBody`), `src/lib/components/chat/ToolActivityRow.svelte` (body markup and status glyph), `src/lib/components/chat/ThinkingBlock.svelte` (192) and `src/lib/components/chat/MessageBubble.svelte` (512) to pass `turnEnded`
- Test: `tool-activity.test.ts`, `ToolActivityRow.test.ts`, `ThinkingBlock.test.ts` ("failed tool calls (E1 status widening)", 1299-1378)

**Interfaces:**
- Consumes: B2's `readReasonCode`, `resolveToolReason`.
- Produces: `buildToolActivityItem(segment, key, translate, options?: { turnEnded?: boolean })`. The shown status comes from the kind (fail to `failed`, stop to `skipped`, info and empty to `done`); the stored `segment.status` is never written. A body `{ kind: "reason"; text: string }` (one sentence) when the words have a key; none when `key` is null. Empty: meta `toolRows.meta.nothingFound` ("nothing found" / "nincs találat"), no body. A failure row whose verb does not already say it keeps meta "Failed". `turnEnded && segment.status === "running"` reads as `stopped`. A row with `ok: false` or `status: "failed"` and no code gets its tool's fallback sentence. The strip (`buildToolActivitySummary`) groups by the shown status, so a stop is never "failed".

- [ ] **Step 1: Write the failing tests**: one per kind (fail with sentence and "Failed" meta; stop with `skipped` and its sentence; empty with "nothing found" and no body; info as done with its line); "a running row of a finished reply reads as stopped" (and stays running while the reply streams); "draws every tool's pre-change failure shapes with its fallback and no raw text": for every catalogue tool name, three segments (status failed + `metadata.error`; done + `ok:false` + `outputSummary`; `tool_error` metadata `{ok:false, error, errorCode:"timeout"}`), with the sentinel `"RAW-SENTINEL-7f3a"` in `outputSummary`, `metadata.error`, `resultDigest`, and an extra input argument appended last whose key and value both carry it (a row may show a call's own leading words, such as a query, a title or a place, so the sentinel is never the first input value), built in `en` and `hu`: no string anywhere in the item contains the sentinel, and none throws. In `ThinkingBlock.test.ts`: a saved (not streaming) message with a `running` web search draws the stop glyph and the stopped sentence.
- [ ] **Step 2: Run** `npx vitest run src/lib/utils/tool-activity.test.ts src/lib/components/chat/ToolActivityRow.test.ts src/lib/components/chat/ThinkingBlock.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, and render the `reason` body as one `--text-sm` line in `--text-primary`.
- [ ] **Step 4: Run** `npx vitest run src/lib/utils/ src/lib/components/chat/`. Expected: PASS.
- [ ] **Step 5: Commit** (`feat(chat): tool rows say why, once, in the person's words`, trailer `Tool-Rows-Task: B3`).

### Task B4: The web, memory, Python, reads, skills and suggestions

**Files:**
- Modify: `src/lib/utils/tool-activity.ts` (web-search 988, image-search 1014, fetch-url 1033, run-python 1072, map-route 1094, use-skill 1138, the artifact branch 1168-1344, memory 1346, read tools 1374, `describeToolIdentity` 1423), `ToolActivityRow.svelte` (new bodies; the card's `failedReason` at 382), `src/lib/i18n/tool-rows.ts`
- Test: `tool-activity.test.ts`, `ToolActivityRow.test.ts`

**Interfaces:**
- Produces bodies: `{ kind: "thumbs"; items: { src: string; host: string; title: string }[] }` (`src` from `imageThumbnailRouteUrl(candidate.metadata.thumbnail)` for candidates passing `isBraveThumbnailUrl`, `host` from the candidate's source, at most 5); `{ kind: "things"; icon: ToolCallIconType; items: { title: string; sub?: string }[]; more: number }` (also used by B5); `{ kind: "result"; text: string }` (Python's `displayOutput`, plain text, not monospace).
- Rows (plan words in `tool-rows.ts`):
  - image_search: meta `toolRows.meta.pictures` ("{count} picture{count, plural, one {} other {s}}" / "{count} kép"), body thumbs; a broken thumbnail hides itself.
  - fetch_url `link_not_from_a_source`: verb `toolRows.verb.didntOpen` ("Didn't open" / "Nem nyitotta meg:"), object the host.
  - memory_context with `metadata.mode` `history` or `project`: verb `toolRows.verb.lookedThrough` ("Looked through" / "Átnézve:"), object `toolRows.meta.pastChats` ("{count} past chat{count, plural, one {} other {s}}" / "{count} korábbi beszélgetés"), body things (chat titles); persona: the existing bullets of the candidates' statements, or no body.
  - run_python: body result from `displayOutput`; none when absent; no program anywhere.
  - read_artifact and read_generated_file: no body; `objectSuffix` from `input.page` ("· page {n}" / "· {n}. oldal") or `input.part` ("· part {n}" / "· {n}. rész").
  - use_skill: no body on success; `skill_not_found`: verb `toolRows.verb.noSkillCalled` ("No skill called" / "Nincs ilyen készség:"), object the input name, no body.
  - suggest_instruction: verb `toolRows.verb.suggestedInstruction` ("Suggested an instruction" / "Utasítást javasolt:"), object the offered text, no body (today it falls to `describeToolIdentity`'s "Tool").
  - map_route without a map: object `"{origin} → {destination}"` from the input; `place_not_found`'s sentence takes `{place}` from `metadata.reasonPlace` (spec words with the example replaced by the param).
  - create_artifact and edit_artifact failures (the branch at 1314-1340 and the `artifact-failed` body at 1283-1307, drawn by `ToolActivityRow.svelte:382` as the card's `failedReason`): the reason is the code's sentence from the registry, never `outputSummary`. `changed_since_read`: verb `toolRows.verb.leftAsItWas` ("Left as it was:" / "Változatlan maradt:"), the quiet stop, its sentence. `request_adjusted`: verb `toolRows.verb.adjustingRequest` ("Adjusting the request" / "Kérés pontosítása"), the quiet stop, no body. Every other code keeps today's "Couldn't create:" / "Couldn't edit:" verb with its sentence. `artifact: { id, failed: true }` stays on every failed row and every stop row (`changed_since_read` and `request_adjusted` included), so a reply still folds an attempt that a later call made good (`utils/artifact-deliverables.ts:66-100`).

- [ ] **Step 1: Write the failing tests**, one per row above, each in `en` and `hu`; "1 picture" and "5 pictures" ("5 kép"); "1 past chat" and "3 past chats"; a `ToolActivityRow` render test where a thumbnail's `error` event hides that thumbnail; "the Python row never shows the program"; "a refused create's card shows its code's sentence, not the model's words" (the card's `failedReason` for `reply_limit_reached`, and for an unknown code the create fallback); "a failed edit that a later edit made good is still folded" (keep the existing fold test green).
- [ ] **Step 2: Run** `npx vitest run src/lib/utils/tool-activity.test.ts src/lib/components/chat/ToolActivityRow.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/lib/utils/ src/lib/components/chat/ src/lib/i18n/`. Expected: PASS.
- [ ] **Step 5: Commit** (`feat(chat): each tool's row shows what it found`, trailer `Tool-Rows-Task: B4`).

### Task B5: Your accounts

**Files:**
- Modify: `src/lib/utils/tool-activity.ts` (`buildConnectorActivityItem` 1454-1505), `ToolActivityRow.svelte` (the `actions` body: per-call sub and things), `ThinkingBlock.svelte` (the connector calls at 333, 1331, 1360 pass `turnEnded`), `src/lib/i18n/tool-rows.ts`; move `formatEventTime` from `ThinkingBlock.svelte` (672) to `src/lib/utils/tool-evidence-presentation.ts` beside `getAgendaCandidates` (224) as `formatEventTime(iso: string, locale: string): string` (today it formats with `Intl.DateTimeFormat(undefined)`, the browser's locale, not the UI language), and import it in both places
- Test: `tool-activity.test.ts`, `ToolActivityRow.test.ts`

**Interfaces:**
- Produces: `buildConnectorActivityItem(tools, key, translate, options?: { turnEnded?: boolean; locale?: string })`; with `turnEnded`, a call still `running` reads as `stopped`, as in B3. The row's shown status is the worst kind among its calls (fail over stop over done). The object is the sum of the calls' counts in the tool's unit (`eventCount`, `messageCount`, `contactCount`, `repoCount`, `taskCount`, `resultCount`), as `toolRows.unit.<tool>` with a count ("3 events" / "3 esemény"); "N actions" stays only when no call counted anything. The `actions` body: each call's glyph by its kind, its phrase `toolRows.connector.<tool>.<action>` (one per value of the tool's `action` enum), its count as the sub, then up to 5 things from its candidates (calendar sub: the start time via `formatEventTime`), then `toolRows.more` ("and {count} more" / "és még {count}"); a call with a code gets its reason line instead. Photos keep "Looked at N photos". Placeholder titles (A1's constants) show as `toolRows.placeholder.untitledEvent` ("Untitled event" / "Névtelen esemény"), `.noSubject` ("No subject" / "Nincs tárgy"), `.photo` ("Photo" / "Fotó"); a title starting with `LOCATION_AT_PREFIX` shows as `toolRows.placeholder.placeAt` ("A place at {time}" / "Egy hely, {time}") with the time formatted.

- [ ] **Step 1: Write the failing tests**: "every action of every account tool has a phrase in both languages" (parse each of the nine tools' `action` enum from `tool-catalogue.en.snapshot.txt`); "takes the worst kind among a run's calls" (fail + done gives failed; stop + done gives skipped; the strip counts no stop as failed); "the object counts what came back" ("3 events"; two calls of 2 and 1 events give "3 events"; nothing counted gives "2 actions"); "lists at most five things, then and N more"; "localizes the server's placeholder titles" (`en` and `hu`, location time in the UI language's format, the time zone pinned in the test with the formatter's `timeZone` option); "an account call still running in a finished reply reads as stopped"; counts of 1 and many in `en` and `hu`.
- [ ] **Step 2: Run** `npx vitest run src/lib/utils/tool-activity.test.ts src/lib/components/chat/ToolActivityRow.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, with the phrases and units written out per tool in both languages.
- [ ] **Step 4: Run** `npx vitest run src/lib/utils/ src/lib/components/chat/ src/lib/i18n/`. Expected: PASS.
- [ ] **Step 5: Commit** (`feat(connections): account rows say what Alfy looked at and what came back`, trailer `Tool-Rows-Task: B5`).

### Task B6: Pictures and clips

**Files:**
- Modify: `src/lib/utils/tool-activity.ts` (`makeImageRow` 681-800, `videoReasonKey` and `makeVideoRow` 835-940, `IMAGE_REASON_KEYS` 443-490: replaced by the registry), `src/lib/components/artifacts/takes/take-card-view.ts` (`takeCardState` 67-114, `takeStateWords` 158-187), `TakeCardShell.svelte` (116-119, 224-245), `src/lib/i18n/chat.ts` (the text of `toolActivity.pictureReason.transparentUnavailable`, EN and HU, to the spec's sentence)
- Test: `tool-activity.test.ts` (make_image 1810-2215, make_video 2251-2456), `takes/take-card-view.test.ts` (219), `image/ImageCardBody.test.ts` (794), `video-card.test.ts` (153), `tests/e2e/images-pipeline.spec.ts` (841-853)

**Interfaces:**
- Produces: the picture and clip rows take their kind from the registry: `explicit_request`, `transparent_unavailable`, `image_blocked`, `video_blocked`, the clip stops `not_asked_for` and `explicit_request` are the quiet stop; `image_unchecked` and `video_unchecked` stay fail; a Stop (`imageStopped`, `videoStopped`) is the quiet stop with today's verbs ("Picture stopped", "Stopped the video"); the clip's stops read `toolRows.verb.videoNotMade` ("Video not made" / "A videó nem készült el") and `unknown_picture` `toolRows.verb.adjustingVideo` ("Adjusting the video request" / "Videókérés pontosítása", no body). `takeCardState`'s failed state carries `errorCode`, and `takeStateWords` gives the code's sentence from the registry (picture and clip alike) instead of `artifacts.take.failed`; the blocked and unavailable states stay as they are.

- [ ] **Step 1: Write the failing tests**: the kinds above (reverse the tests that pin red at 1980, 2072, 2102, 2136, 2199, 2404; the Stop test at 2215 now expects `skipped`); "a failed take's card gives its code's sentence" for `image_render_timeout` and `video_render_failed`; "the transparency sentence names no Admin setting" (`en`, `hu`).
- [ ] **Step 2: Run** `npx vitest run src/lib/utils/tool-activity.test.ts src/lib/components/artifacts/`. Expected: FAIL.
- [ ] **Step 3: Implement**, and update `images-pipeline.spec.ts:841-853` to the new sentence and the quiet row (run it at the end with the gate).
- [ ] **Step 4: Run** `npx vitest run src/lib/utils/ src/lib/components/`. Expected: PASS.
- [ ] **Step 5: Commit** (`feat(images): pictures and clips follow the tool-row rule`, trailer `Tool-Rows-Task: B6`).

### Task B7: The file card and the Atlas row

**Files:**
- Modify: `src/lib/components/chat/FileProductionCard.svelte` (`ERROR_MESSAGE_KEYS` 32-79, `statusDescription` 119-137), `src/lib/components/chat/AtlasActivityBody.svelte` (189-190, 513), the i18n module that holds `fileProduction.error.*` (add the missing codes there, beside their siblings)
- Test: `FileProductionCard.test.ts` (99-183), `AtlasActivityRow.test.ts` (540-575), `AtlasActivityRow.stored-rows.test.ts` (~180-205), and turn B2's file-maker scan test from todo to real

**Interfaces:**
- Produces: `statusDescription` never returns `job.error.message`; an unknown code gives `fileProduction.failedDescription`. The file maker's codes (they are open strings across files, so this list is what the B2 scan must find at least): the limits `too_many_outputs`, `source_too_large`, `projection_too_large`, `page_limit_exceeded`, `table_limit_exceeded`, `chart_limit_exceeded`, `image_limit_exceeded`, `renderer_timeout`, `sandbox_timeout`, `output_file_too_large`, `job_outputs_too_large` (`file-production/limits.ts:3-15`); `missing_file_production_request`, `invalid_file_production_request`, `unsupported_file_production_request`, `unsupported_output_type`, `missing_program_requested_outputs`, `program_execution_threw`, `program_execution_failed`, `generated_document_source_persistence_failed`, `document_render_failed`, `inline_text_write_failed` (execution-adapter.ts); `program_no_outputs`, `program_output_storage_failed` (storage-adapter.ts); `invalid_inline_text_request`, `missing_inline_text_content`, `unsupported_inline_text_output_type`, `invalid_json_body`, `missing_conversation_id`, `missing_idempotency_key`, `missing_request_title`, `unsupported_source_mode`, `invalid_program_language`, `missing_program_source`, `missing_program_output_type`, `unsupported_program_output_type` (intake.ts); `invalid_document_source`, `unsupported_document_block`, `unsupported_table_structure`, `unsupported_chart_type`, `unsupported_chart_data` (source-schema.ts); `pdf_font_missing`, `unsupported_pdf_block` (renderers); `render_cancelled` (render-budget.ts); `worker_state_lost`, `worker_heartbeat_timeout`, `worker_queue_timeout` (lost-attempt.ts, production-job.ts:460); `invalid_tool_input`, `no_previous_version_for_patches`, `patch_failed`, `patch_not_applicable`, `file_production_no_output_files`, `tool_execution_failed`, `produce_file_turn_retry_limit`, `produce_file_turn_limit` (the tool); and the card's `tool_failed`. The codes the card words today keep their words (`FileProductionCard.svelte:32-79`); `unsupported_inline_text_output_type` takes `unsupported_output_type`'s words; the rest are grouped (plan): request-shaped codes (`invalid_tool_input`, `missing_file_production_request`, `invalid_file_production_request`, `unsupported_file_production_request`, `invalid_inline_text_request`, `missing_inline_text_content`, `invalid_json_body`, `missing_conversation_id`, `missing_idempotency_key`, `missing_request_title`, `unsupported_source_mode`, `invalid_program_language`, `missing_program_source`, `missing_program_requested_outputs`) "The file request couldn't be read." / "A fájlkérés nem olvasható."; worker and storage codes (`program_execution_threw`, `program_execution_failed`, `program_output_storage_failed`, `generated_document_source_persistence_failed`, `inline_text_write_failed`, `tool_execution_failed`) "The file maker ran into a problem." / "A fájlkészítő hibába ütközött."; `program_no_outputs` and `file_production_no_output_files` "The program made no file." / "A program nem készített fájlt."; `no_previous_version_for_patches`, `patch_failed`, `patch_not_applicable` "The change couldn't be applied to the file." / "A módosítást nem sikerült alkalmazni a fájlon."; `produce_file_turn_limit` and `produce_file_turn_retry_limit` "Alfy has made as many files as one reply allows." / "Alfy ebben a válaszban már annyi fájlt készített, amennyit lehet."; `render_cancelled` the shared stopped sentence. The Atlas body's failure line is `resolveToolReason("atlas", job.error?.code ?? null)`'s sentence, never `job.error.message`; legacy codes give the fallback.

- [ ] **Step 1: Write the failing tests**: "an unknown file code never shows its message"; one test per group above; the Atlas tests (540-575 and the stored-rows ones) now expect the code's sentence; the scan test is real.
- [ ] **Step 2: Run** `npx vitest run src/lib/components/chat/FileProductionCard.test.ts src/lib/components/chat/AtlasActivityRow.test.ts src/lib/components/chat/AtlasActivityRow.stored-rows.test.ts src/lib/utils/tool-reason-words.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** (`feat(chat): the file card and the Atlas row word every failure`, trailer `Tool-Rows-Task: B7`).

### Task B8: The rule, written down, and the end-to-end specs

Merge `tool-rows/server` again first (all of A1 to A8).

**Files:**
- Modify: `AGENTS.md` (Core Rules: one line), `src/lib/components/chat/AGENTS.md` (new section "Tool Rows")
- Modify: `tests/e2e/chat-failed-tool-row.spec.ts` (rewrite), `tests/e2e/chat-one-card-per-item.spec.ts` (16, 48-85: the failed-row counts and the strip text, where the case is now a stop)
- Test: the two specs, run by the orchestrator in the final gate

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the rule.** Root `AGENTS.md`, Core Rules, one line: an opened tool row says what happened in plain words in both languages, every error case a tool's server code tells apart has its own words, codes and raw error text stay in the server log, and `src/lib/components/chat/AGENTS.md` ("Tool Rows") and `src/lib/utils/tool-reason-words.test.ts` hold it. The chat folder's "Tool Rows" section: the spec's five points; codes live in `src/lib/shared/tool-reasons.ts` (closed lists), words in `src/lib/i18n/tool-rows.ts`, the mapping in `src/lib/utils/tool-reason-words.ts`; a new tool or code ships with its words or the test fails; the stored status never changes; a code travels beside the payload, never in it.
- [ ] **Step 2: Rewrite `chat-failed-tool-row.spec.ts`** (Hungarian). Its `giveup` scenario sends malformed patch ops, which the Document handler refuses (`edit.ts:333-339`) and A8 tags `request_adjusted`: the row is now the quiet stop, `data-status="skipped"`, its accessible name and text "Kérés pontosítása: <title>", no body, no chevron, no "Részletek" and no English anywhere in the row; at a 390 px viewport the row's verb is fully visible (`expect(verb).toBeInViewport({ ratio: 1 })`). In `chat-one-card-per-item.spec.ts` (16, 48-85) the scenario's rows are now stops: `FAILED_ROW` counts and the strip text ("Nem sikerült szerkeszteni", ~74-76) change to the stop row and its strip label.
- [ ] **Step 3: Run** `npx vitest run` for every unit test touched by B1 to B7 once more, and `npm run check`. Expected: PASS, 0 errors and 0 warnings. (The specs run in the orchestrator's gate.)
- [ ] **Step 4: Commit** (`docs(agents): the tool-row rule, and the end-to-end specs that hold it`, trailer `Tool-Rows-Task: B8`).
