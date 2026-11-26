# Memory redesign: a native Memory that stays useful (2026-11-22)

Status: design, agreed with the owner in conversation from 21 to 23 November 2026; a builder check's nine questions are answered in place (see "Calls I made"). Not built.

## Why

Memory is AlfyAI's centrepiece and its lock-in. Other services run smarter models; AlfyAI keeps people because Alfy knows them and keeps knowing them better, privately, on the owner's own model. People use the local model for 95% of their chats, so everything here is built and tested around it.

The move to Hindsight fixed the everyday errors of the old system (missed facts, other people's facts filed as the person's, "owns" from a question). It measured far better: 80 to 90% relevant against 30 to 40%, and 50 of 72 benchmark answers against 37. What it does not solve is the long run:

- **Entries pile up.** Hindsight's consolidation rule is "one short sentence about ONE subject and ONE facet; never add a new facet to an existing observation" (`hindsight_api/engine/consolidation/prompts.py:100` at our pin `9fb28dbd`), and our observations mission repeats it (`src/lib/server/services/memory-profile/contracts.ts:48`). Nothing merges different facets later; only near-identical entries are merged (similarity 0.97, then a model check). On the owner's account 316 of 357 entries hold a single fact. A six-turn brainstorm about a game character's name produced 5 facts and 7 entries, of which one was worth keeping. On the benchmark Hindsight published 141 entries where the old system kept 66, from the same 102 messages.
- **Nothing ages.** Hindsight has no expiry, duration or "valid until" anywhere (not found at the pin). Recall's recency weighting is a ±10% nudge. A toothache stays as current as a sister.
- **Recall starves projects and ignores the message.** The recall injected into every turn (`src/lib/server/services/chat-turn/context-selection.ts:418-425`) searches with one fixed sentence, "Relevant user preferences, constraints and current context", not with what the person wrote. `recallMemory` (`src/lib/server/services/memory-context/native.ts:155-175`) then fills one token budget bank by bank, personal first. Sales has 386 personal entries and 98 and 91 project entries; in a project chat recall returns about 230 personal rows and no project rows, even when the query is a project entry's exact text. This is why sales' recall check failed after its cutover (see "Production evidence").
- **Every Memory job is fragile on one local model.** The admission gateway (`deploy/hindsight/alfyai_admission.py`) refuses an over-budget model call at once with 429 instead of letting it wait; the engine retries briefly. Our delivery jobs wait 180 seconds for retain, consolidation and capture (`delivery-runner.ts`), while serialized inference takes up to about 4 minutes for a retain and 3 to 7 minutes for a consolidation. Jobs end `native_operation_timeout` although Hindsight finishes their work. Finishing sales took supervised retries and hand-run recovery scripts.

The owner's goal: settle a working system that can ship and be left alone for a long time. Not a patch.

## What the owner decided

- Memory must feel effortless and invisible. People rarely open the Memory page; when they do it must not be a graveyard of fragments. Occasional correction by the person is fine; 100% accuracy is not the goal.
- New memories must be available in the next chat. Delivery stays per turn; nothing is batched or delayed to reduce volume.
- Everything works with, and is tested on, the local model. Nothing leaves the box: no hosted helper or decision model.
- Keep Hindsight as the engine. Do not rebuild the old system's machinery (write-time expiry guesses, nightly reconciliation, compound merges) inside it.
- Four kinds of memory age differently:
  1. **Lasting facts** (who you are, family, languages, values, long-held tastes) are kept until something replaces them.
  2. **Current situation** (where you live or study, your parents' home) can have several values true at once. When one changes, the new one is current and the old one becomes dated history, available if needed, never presented as now.
  3. **Temporary states** (sick, a toothache, an exam next week) stop being brought up on their own after days or weeks, without the person saying they are over; afterwards a dated line of history.
  4. **One-off chat details** (brainstorming steps, a question asked, reactions to Alfy's suggestions) are not memories, except a lasting outcome.
  - Projects sit between 2 and 3: active while talked about, quiet when not, back the moment they are mentioned again. Nobody has to close a project.
- The Memory page uses **layout C, a subject index** (mockups in `docs/design/memory-redesign/`: phone 3 and 4, the Overview sheet 6 and 7, desktop 8 to 10).
- **An Overview of the person comes back**, behind one row at the top, written only when opened, never refreshed in the background and never fed to chats (mockups 6, 7 and 10).
- **The new subjects need a migration for every user's existing entries. The tester account (tester@tester.com) is excluded from it, and from every Memory migration, forever.**
- When the legacy system is retired, the tester account starts fresh on native Memory with nothing carried over (decided 23 November 2026).
- Recall must be fair to projects; model calls must wait their turn instead of failing; jobs must wait for Hindsight to finish; migration follow-ups only matter while accounts move between systems.
- Order: (1) fair, time-aware recall; (2) what is remembered, the labels and the page; (3) model access that waits and jobs that wait; (4) retiring what migration no longer needs.
- Ruled out: Hindsight mental models and Reflect for this purpose (they summarise on top and remove nothing; refreshes keep up to 50 stored versions including removed text; Reflect cannot be limited to given entries and bypasses our filtered recall), TTL or expiry jobs, nightly reconciliation, a merge or canonicaliser engine, entry caps, the validator veto hook, and any hosted helper.

## The idea that holds it together

**Never delete on a guess; decide at read time.** The old system guessed an expiry when it saved a fact, without ever telling the model the date (its judge prompt carried no dates; reconcile sent facts without dates), then deleted on the guess. Hindsight records real dates: each fact's assertion date, and an entry's `mentioned_at`, which moves forward when a new fact joins the entry (`engine/memories/pg/consolidation.py:300-303`). So the system keeps what Hindsight stores and decides, when recall and the page read it, what counts as current. A rule that is too eager loses nothing. Storage still grows slowly; what stays small is what the person sees and what Alfy brings up.

## Goals

- In a project chat, the project's own entries reach the model (sales unblocked).
- The person's basics reach every chat, and what the person is talking about brings its own entries.
- Anything no longer current comes up only when the person mentions it, marked as earlier with its date; each recalled row shows its age and kind to the model.
- About one entry per lasting thing said, not one per brainstorm step.
- A Memory page a person can take in at a glance: a short subject index, with temporary and quiet things folded away.
- An Overview that never contains anything the person removed.
- Memory jobs that finish on their own under a busy local model, with no hand-run recovery.
- One memory system left to maintain.

## Non-goals

- Perfect accuracy or perfect labels.
- Changing how Hindsight extracts or consolidates internally (no fork, no upstream work).
- A Hindsight upgrade (v1.2.3 fixes none of these; it is a separate decision).
- Reducing what is stored. Storage keeps everything Hindsight keeps.

## Anti-goals (would make this a failure even if it works)

- Memories appearing later than the next chat.
- Anything the person removed or edited coming back, in recall, on the page or in the Overview.
- A new background engine that rewrites or deletes entries on its own.
- An entry kept current by being recalled rather than by what the person says.
- Anything that needs a smarter model than ours, or any data leaving the box.
- The tester account touched by any migration.

## Constraints

- Local model only (Flash-Next on the box). Every behaviour is accepted on it, with synthetic data only (never real users' data).
- One inference slot by day, six overnight (`deploy/hindsight/README.md`); any added model call competes with the person's next turn. Prefer zero added calls per turn.
- Hindsight recall makes no model call in our deployment: dates in the query are read by `dateparser` (`engine/query_analyzer.py`), ranking uses the GPU embedder and the BGE reranker (`deploy/hindsight/compose.gpu.yaml`), and the optional decision model is not configured (`HINDSIGHT_API_DECISION_MODEL_*` unset). Changing what recall searches for costs no inference slot.
- Project memory never leaves its project; personal memory may accompany any chat.
- All model-facing text is English (ruling 79, `src/lib/server/services/chat-turn/AGENTS.md`); UI text is English and Hungarian.
- Bank configuration changes reach every bank: `verifyConfig` compares each key (`hindsight-client.ts:267-274`), and array or object keys need deep comparison.
- Repository gates, an independent Opus review per part, paired backups and canonical tools for anything run on production. Production deploys only on the owner's word.

## The design, in delivery order

### 1. Fair, time-aware recall

Today: the per-turn recall searches with a fixed sentence; banks are recalled in order (personal, then the current project) and each fills one shared budget until it is gone. Rows reach the model as bare text with no date.

New behaviour:

- **Two parts per turn, one budget.** A stable **core** of the person's basics (today's fixed profile search; once labels exist, lasting entries first) takes at most a quarter of the budget, so basic facts reach every chat whatever the message says. The rest is filled by **relevance to the person's latest message** across the eligible banks.
- **A fair split.** In a project chat half the budget is reserved for the project bank, filled by the message and topped up with the project's general entries. Any share left unused passes to the others. A personal chat uses the personal bank only.
- **Earlier entries only when mentioned.** Earlier entries (part 2) never enter the core. In the relevance part an Earlier entry may appear only when it ranks at the top for the person's message: at most three per turn, each marked as earlier with its date. A toothache comes back when the person mentions their tooth again, an old address when they mention the old city; neither is brought up on its own.
- **The model's own lookups** (the `memory_context` tool, `memory-context/persona.ts`) search with the model's query and may return Earlier entries and earlier-state notes, always marked as earlier with their dates. Recall therefore has two modes, one per caller.
- **Age and kind visible.** Each recalled row says how long ago it was last mentioned and, once labelled, its kind (for example "temporary, said 3 weeks ago"; before labels just "said 3 weeks ago"), so the model can judge relevance with the clock it already has (`normal-chat-context.ts`, `buildTimeContextLine`). The old system's time failures came from giving the model no dates.
- **Recall never counts as activity.** Only Hindsight's `mentioned_at` ages or revives an entry. Being recalled, matched or shown changes nothing, so no entry can keep itself alive.
- **Budget** stays the configured recall budget (config-store); the shares and the age thresholds are config-store settings with defaults (see "Calls I made").

Part 1 can ship before part 2, and may ship in two steps: the fair split first (it alone unblocks sales), then the message search and the core. Until labels exist every entry counts as lasting: nothing is Earlier and rows show their age without a kind.

Acceptance (local model, synthetic data, English and Hungarian messages):

- An account shaped like sales (about 400 personal entries, projects of 100 and 90) gets project entries in every project chat where they are relevant, and a message quoting a project entry's text brings that entry.
- A short message ("thanks") still carries the person's basics.
- A message in Hungarian finds the entries it is about.
- With the second search, recall stays inside its existing 2-second limit per bank.
- After deploy, sales passes the post-cutover recall check (`rollout-recall.mts`, an operator script on the box, not in the repository), run with the owner's approval.

### 2. What gets remembered, and how it is labelled

**Extraction (retain mission, config only).** Add to the retain mission that requests to Alfy, reactions to its suggestions and the intermediate steps of a brainstorm or a choice are not memories; when a choice settles, its outcome is, if it is likely to matter beyond the chat. Hindsight's concise mode already asks "useful in 6 months?" (`engine/retain/fact_extraction.py:1146-1166`); the mission takes priority (`:1813-1830`). Check with `POST /memories/dry-run-extract` (already wired, persists nothing) before rollout.

**Consolidation (observations mission, config only).** Add that when a later statement settles an earlier wish or plan about the same thing, only the settled state is kept; a real-world change (a move, a new job) makes the new state current and leaves the old one to Hindsight's earlier-state note. The mission asks for no end dates: Hindsight dates the note by when the old statement was made, and the page shows that date (part 3); a date appears in an entry's text only when the person stated one. This must not weaken corrections: a correction ("no, Graz, not Vienna") leaves no history of the wrong value, as today's correction suites require. Keep "one subject and one facet": grouping happens on the page, not in storage, because the facet rule was tuned for small models and our correction and withdrawal guarantees depend on it. `POST /prompts/preview` shows the rendered prompt (no model call); behaviour is measured with the dry-run sets under "Testing".

**Two labels, assigned inside the extraction Hindsight already runs** (no new pipeline, no added call). Hindsight's per-bank `entity_labels` classify each fact during extraction and write the label to the fact's tags (`fact_extraction.py:1696-1702, 3879-3897`; docs `api/memory-banks.mdx:142-190`):

- **Kind**, three values:
  - **lasting**: identity, family, languages, values, long-held tastes, and the current situation (where the person lives or studies, the family home). Never aged by silence; only replaced.
  - **ongoing**: project-like activity (a thesis, an app being built, learning a tool). "Quiet" after a while without a new fact, Earlier after longer, current again as soon as a new fact about it is remembered.
  - **temporary**: states with a natural end (sick, a toothache, an exam, a trip). Earlier a while after the later of its last mention and its event date, so an exam two months away stays current until it has passed. Hindsight stores occurred dates for facts.
  - When unsure, the label leans toward lasting: a wrongly lasting entry stays visible and the person can remove it, while a wrongly temporary one silently drops out of recall.
- **Subject:** one of a fixed short list per bank type, each ending in "Other" so every entry has a row (lists under "Calls I made"). Free-form topics were rejected: they would bring the pile back one level up (a subject per game character, per tool).

Entries the person added or edited never age: the person's own words are not second-guessed.

Under our untagged `shared` observation scope, observations carry no tags, so an entry takes its kind and subject from its supporting facts (the most recent fact wins on a disagreement); `NativeMemory` gains a `tags` field. The label is also a graph entity in Hindsight; its effect on recall must be measured.

**If labels fall short.** If in-extraction labels miss the targets on the local model, or measurably hurt recall as graph entities, new facts get their labels from a background classification call instead: the same local-model classifier the label migration uses, queued behind live turns in the admission queue (part 4), never on the person's turn. If that also misses, the measured numbers go to the owner before anything ships.

**Earlier.** An entry is Earlier when it is temporary past the temporary threshold (counted as above), or ongoing past the Earlier threshold for quiet projects. A lasting entry is never Earlier. A superseded state is not a separate entry: it is an earlier-state note on the current entry (Hindsight keeps up to three, which `splitNativeNotes` strips from the text today; `GET /memories/{id}/history` keeps 50 snapshots). Only a new fact moves `mentioned_at`, so a project whose talk produces nothing new to remember shows as quiet on the page while still reaching any chat whose message matches it (part 1).

### 3. The Memory page (layout C) and the Overview sheet

- **Top:** the Personal/Project selector and Add, as today.
- **Overview row:** closed until opened. Opening shows a sheet (a centred dialog on a computer): "Writing your overview…" from N current entries, then a short paragraph, "Written just now from your N current entries. It is written again whenever your Memory changes, and it is never sent to chats.", with Rewrite and Done.
- **Search,** as today.
- **Subject index:** one row per subject with the count of its current entries and a one-line preview (the subject's most recent current entry); subjects with no current entries are hidden. The Projects row shows an "active" tag when any of its entries is active, and no count of projects, because entries carry no project identity.
- **On a computer** the index shows as tiles (mockup 8).
- **An opened subject:** on a phone a pushed screen with a back link to Memory (mockup 4); on a computer a second pane beside the index, which becomes a list (mockup 9). Its current entries, most recently mentioned first, each with when it was last mentioned. An entry with earlier-state notes shows them on a quiet line with the date each stood ("Earlier: lived in Budapest · as of March 2025", no date for one after now); no end date is invented. Ongoing entries show "active" or "quiet N weeks". The subject's own "Earlier" row folds its Earlier entries.
- **An "Earlier" row on the index** folds everything Earlier across subjects.
- **Editing and removing** stay on the entry, with today's dialogs and guarantees. The entry's detail view keeps its "Previous versions" section for the person's own edits; Hindsight's earlier-state notes are not mixed into it.
- **Existing accounts** keep today's page until their labels are verified (see "The label migration"); new accounts get the new page from the start.
- **Strings** in English and Hungarian; the Feature Guide entry for Memory updated in the same change (`src/lib/components/guide/`).

**The Overview** is written by one call to our local model over the entries the page shows as current for that scope, through the app's own model-call path (sampling via `resolveModelCallSampling`, English prompt, written in the person's language). When a scope has more current entries than fit one call, it is written from the most recently mentioned ones that fit, and the line under it says so ("Written from your 120 most recent entries of 300"). It is kept until any entry in the scope changes, then discarded; Clear Memory, account erasure and scope moves delete it; it is never stored with copies of earlier versions and never sent to chats. Hindsight mental models and Reflect are not used (see "What the owner decided").

The mockups' subject names and counts are examples (this document's lists govern), and the small orange caption on each names the mockup; it is not part of the UI.

### 4. Model access that waits, and jobs that wait for Hindsight

- **A queuing admission gateway.** Over-budget model calls wait in a bounded, fair queue (live turns before background work, fair across tenants and between Hindsight's calls and the app's own memory calls) instead of a 429. Then native fan-out can rise again from today's 1, and the engine's retries can return near the default from today's 12, each only as measurements allow.
- **Jobs that wait on Hindsight's own operation state.** Retain, consolidation and capture wait until Hindsight reports the operation terminal, within long bounded deadlines set through config-store, and time spent waiting does not consume a job's attempts.
- **Resubmit-once follow-ups** (review of `73362c397`, "Resubmit a failed Hindsight retain once under a new operation id"): delay the resubmit so it does not meet the same refusal (S1); record the terminal end on the revision so a forgotten operation cannot be sent a third time (S2); tests with a real chat context envelope (S3). The review's six nits (N1 to N6) are not written down anywhere the builder can read: review `73362c397` again and fix what it finds.
- **Canonical operator tools** for what was hand-run during the rollout, each printing every step's result so a failure names its step:
  - resend one chat's delivery under a new operation;
  - reattach a delivered document to its job;
  - reset a fact stuck in consolidation through Hindsight's `POST …/consolidation/recover`;
  - a drain that continues past holds and timeouts and ends with a summary of what it skipped and why.
- **The gateway's Python tests** (`deploy/hindsight/test_*.py`) join `scripts/gates.sh`.

### 5. Retiring what migration no longer needs

After the last rollback window closes (sales: 22 December 2026; verify each account's `rollbackUntil` first):

- Remove the legacy memory system's code (judge, nightly consolidation, the projection's write paths) and the migration-only machinery and operator scripts (prepare and rewind for migration, correction holds, the meaning-check approval tooling, `cc-*` scripts), keeping everything live accounts use: per-turn delivery, curation (edit, remove, add), publication, recall, the imported-history take-up and the history rules it relies on, Clear Memory and erasure.
- This part removes code, not data. Dropping the legacy tables is a separate, later decision; until then the tester's legacy rows stay where they are.
- New accounts start on native Memory.
- The meaning-check follow-ups (withdraw-and-hold for a permanent forget failure; two approvals against the wrong baseline; a recorded pass surviving a return to baseline; fresh evidence for the new-assertion check; the repeated plan call) are retired with the tooling. If any new approval is needed before retirement, fix "two approvals against the wrong baseline" first.
- **The tester account starts fresh on native Memory (the owner's decision, 23 November 2026).** It is excluded from every migration, so it is likely the last account on the legacy system. Before the legacy code goes, it is switched to native Memory with empty banks. Nothing is carried over: no legacy rows, no chat history, no take-up of past or imported chats. Its legacy rows are left untouched and its own Memory settings stay as they are; from then on its new chats are delivered like anyone's. The switch is an operator step with a paired backup and the owner's go-ahead. It moves no data, so it is not a migration.
- **The permanent tester rule.** A stored flag on the account, set once for tester@tester.com by a schema migration and keyed by user id from then on. One guard reads it; every migration of existing Memory data calls the guard (the label migration, the operator tools, any future migration), and each has a test showing the tester is skipped. The flag exists before the first label-migration run. Ordinary operation (delivery, bank configuration for new facts) is not a migration.

## The label migration for existing entries

Every existing entry needs a kind and a subject, for every user except the tester (excluded by the permanent rule).

- **When:** after part 4's admission queue is live, because a model-heavy run on today's refuse-at-once gateway would repeat the rollout's failures. Each account gets the new page when its labels are verified.
- One-time, resumable, per account, on the local model, at background priority inside the queue, overnight by default.
- The classifier is a local-model call over each fact; it is also the fallback for new facts (part 2).
- Never changes an entry's text, support, dates or visibility; only adds labels where the app reads them for new facts, so old and new entries read the same way.
- Canonical tooling: dry run first (counts only), paired backups, verify per account before the next, a counts-only report (entries labelled per kind and per subject), the owner's go-ahead before production.
- Mechanism left to the builder, with these limits: re-extracting documents through Hindsight (`reprocess`) is out, because it regenerates entries and their identities; the choice is between writing tags to Hindsight's facts (if the API allows) and an app-side label store keyed by fact, read through one path for old and new facts.

## Testing and acceptance

All on the local model, synthetic data only (English and Hungarian), through the repository gates and an independent Opus review per part. Each behaviour set has at least 20 chats per category, half in Hungarian. The targets are proposals the owner may change.

- **Recall:** as in part 1.
- **Extraction:** question-only chats leave no new entry in at least 9 of 10; a settled brainstorm leaves at most its outcome in at least 8 of 10; plainly stated lasting facts are kept at least as often as with today's missions on the same set.
- **Consolidation:** a real-world change leaves the new state current and the old one as an earlier-state note in at least 8 of 10; today's correction and withdrawal suites still pass.
- **Labels:** kind right for at least 85% of facts and subject for at least 80%; at most 1 in 20 lasting facts labelled temporary or ongoing.
- **Regression gate:** `docs/plans/hindsight-memory/native-lifecycle-acceptance/`, the current-list and edit/remove holdouts (`docs/plans/hindsight-memory/current-list-followup/`) and the integrated benchmark (`docs/plans/hindsight-memory/integrated-native-benchmark/`) stay at or above today's results.
- **Time:** after the threshold (counted from its event date when it has one) a temporary entry is no longer offered on its own and folds on the page; a quiet project is marked and folds; a new fact makes it current again; a message about it brings its entries into that turn, marked as earlier.
- **Overview:** written only from the visible entries; after a removal, a rewrite never contains the removed text; nothing stored after an entry change; a scope too big for one call is written from its most recent entries and says so.
- **Page:** end-to-end spec for the index, an opened subject, Earlier and the Overview sheet, on a phone and a desktop, in both languages.
- **Size:** a synthetic bank of 5,000 entries: recall inside its 2-second limit per bank; the page and the Overview measured and reported.
- **Infrastructure:** with the model held busy, no Memory call fails with 429 and no job ends `native_operation_timeout` while Hindsight is still working.
- **Label migration:** dry run on a copy; per-account verification; the tester untouched.

**Where runs happen.** Runs that need the model use a non-production Hindsight on the box (built from `deploy/hindsight/` with its own secret bundle and worker ID), reaching Flash-Next through the admission gateway at background priority. Heavy runs (building the sales-shaped bank, the label sets, held-busy tests) run overnight; daytime runs stay small. Setting up or deploying anything on the box is an operator step the owner approves.

## Calls I made (the owner may change any of them)

1. **Subject lists.** Personal: About you, Home and family, Work and study, Health, Projects, Interests, Other. Project banks: Goals and decisions, People, Facts and figures, Plans and status, Other.
2. **Kinds.** The current situation (where you live or study, the family home) is lasting: replaced, never aged by silence. Ongoing means project-like activity only. Labels lean toward lasting when unsure. Entries the person added or edited never age.
3. **Thresholds.** A temporary entry is Earlier 3 weeks after the later of its last mention and its event date; an ongoing one shows "quiet" after 3 weeks without a new fact and is Earlier after 3 months. Config-store settings.
4. **Recall per turn:** a core of basics (at most a quarter of the budget) plus a search with the person's message; in a project chat half the budget is the project's. Config-store settings.
5. **Earlier things come back only when mentioned:** at most three per turn, ranked at the top for the person's message, marked as earlier with their date. The model's own lookups may return them, marked.
6. **Only a new fact revives an entry.** Being recalled never counts, so nothing keeps itself alive. A project talked about without anything new to remember shows "quiet" on the page but still reaches chats about it.
7. **Order:** the label migration runs after part 4's queue; each existing account switches to the new page when its labels are verified; until labelled, recall rows show their age without a kind.
8. **Done** means the pass rates under "Testing". If labels fall short, the fallback is a background classifier call queued behind live turns.
9. **Size:** design and test for 5,000 entries per bank; a large scope's Overview is written from its most recent entries and says so.
10. **The Earlier line** shows when the old statement stood ("as of March 2025"; first drafted as "said March 2025", changed on 2026-11-24 because Hindsight's date is the later of when a fact happened and when it was mentioned, and it is shown only when it is not after now), never an invented end date; the consolidation mission asks for no end dates.
11. **The Projects row** shows "active", not a count of projects.
12. **On a phone** an opened subject is a pushed screen (mockup 4).
13. **The Overview** is kept until an entry changes and is written in the person's language.
14. **New accounts** start on native Memory once part 5 lands.
15. **The tester rule** is a stored flag on the account, read through one guard by every migration of existing Memory data; ordinary operation is not a migration.
16. **The six nits** from the review of `73362c397` are found again by a fresh review of that commit.

## Left to the builder

- Exact mission and label wording (tested with dry-run extraction and prompt preview on the local model).
- Where labels live (Hindsight tags or an app-side store), within the rules above.
- How the core is chosen and how relevance is merged across banks within the shares.
- The admission queue's mechanics (bounded wait, fairness, live first).
- Visual details within layout C, matching the app's tokens and the drawing kit.
- How part 5 is staged and tested.

## Production evidence (counts only, 22 November 2026)

- **Recall.** Sales: 386 personal entries; its two projects 98 and 91. In a project chat recall returned about 230 rows, all personal and none from the project, even for a project entry's exact text; the post-cutover check reported `populatedScopesWithoutDefaultRank: 1`. Accounts with small personal banks pass (one surfaced 112 project rows).
- **Admission.** Budget 1 by day, 6 only overnight with a fresh idle signal; the engine's default retries are 3, at 1, 2 and 4 seconds. Native fan-out 6 against budget 1 failed one sales chat three times, and an app curation call sharing the slot left a fact failed in consolidation. Production now runs fan-out 1 and 12 retries.
- **Waits.** `delivery-runner.ts` waits 180 seconds in settle, drain and capture, with 3 attempts per job; the ledger keeps attempt numbers, so a retried job gets one attempt. Retains took up to about 4 minutes and consolidations 3 to 7 minutes.
- **Recovery by hand.** Finishing sales' 356 of 356 deliveries took one resend, one reattach, one consolidation recover and supervised retries.

## Evidence and references

- Mockups: `docs/design/memory-redesign/` (phone 3, 4, 6, 7; desktop 8, 9, 10).
- Our test evidence: `docs/plans/hindsight-memory/` (integrated benchmark, current-list follow-up, fit investigation, capacity results, `ui-inventory.md`, `agreed-ui-design.md`).
- Hindsight at pin `9fb28dbd`: consolidation rules `engine/consolidation/prompts.py`; consolidator `engine/consolidation/consolidator.py`; extraction `engine/retain/fact_extraction.py`; recall `engine/memories/pg/recall.py`, `engine/search/reranking.py`, `engine/query_analyzer.py`; mental models `engine/memory_engine.py`, `engine/mental_model_refresh.py`.
- Current code: per-turn recall `src/lib/server/services/chat-turn/context-selection.ts`; recall `src/lib/server/services/memory-context/native.ts` and `persona.ts`; bank config `memory-profile/contracts.ts`; client `hindsight-client.ts`; delivery `delivery-runner.ts`; admission `deploy/hindsight/alfyai_admission.py`.
