# Memory redesign: a native Memory that stays useful (2026-11-22)

Status: design, agreed with the owner in conversation on 21 and 22 November 2026. Not built.

## Why

Memory is AlfyAI's centrepiece and its lock-in. Other services run smarter models; AlfyAI keeps people because Alfy knows them and keeps knowing them better, privately, on the owner's own model. People use the local model for 95% of their chats, so everything here is built and tested around it.

The move to Hindsight fixed the everyday errors of the old system (missed facts, other people's facts filed as the person's, "owns" from a question). It measured far better: 80 to 90% relevant against 30 to 40%, and 50 of 72 benchmark answers against 37. What it does not solve is the long run:

- **Entries pile up.** Hindsight's consolidation rule is "one short sentence about ONE subject and ONE facet; never add a new facet to an existing observation" (`hindsight_api/engine/consolidation/prompts.py:100` at our pin `9fb28dbd`), and our observations mission repeats it (`src/lib/server/services/memory-profile/contracts.ts:48`). Nothing merges different facets later; only near-identical entries are merged (similarity 0.97, then a model check). On the owner's account 316 of 357 entries hold a single fact. A six-turn brainstorm about a game character's name produced 5 facts and 7 entries, of which one was worth keeping. On the benchmark Hindsight published 141 entries where the old system kept 66, from the same 102 messages.
- **Nothing ages.** Hindsight has no expiry, duration or "valid until" anywhere (not found at the pin). Recall's recency weighting is a ±10% nudge. A toothache stays as current as a sister.
- **Recall starves projects.** `recallMemory` (`src/lib/server/services/memory-context/native.ts:155-175`) fills one token budget bank by bank, personal first. Sales has 386 personal entries and 98 and 91 project entries. In a project chat recall returns about 230 personal rows and no project rows, even when the query is a project entry's exact text. This is why sales' recall check failed after its cutover (hand-over, section 2.1).
- **Every Memory job is fragile on one local model.** The admission gateway (`deploy/hindsight/alfyai_admission.py`) refuses an over-budget model call at once with 429 instead of letting it wait; the engine retries briefly. Our delivery jobs wait 180 seconds for retain, consolidation and capture (`delivery-runner.ts`), while serialized inference takes up to about 4 minutes for a retain and 3 to 7 minutes for a consolidation. Jobs end `native_operation_timeout` although Hindsight finishes their work. Finishing sales took supervised retries and hand-run recovery scripts.

The owner's goal: settle a working system that can ship and be left alone for a long time. Not a patch.

## What the owner decided

- Memory must feel effortless and invisible. People rarely open the Memory page; when they do it must not be a graveyard of fragments. Occasional correction by the person is fine; 100% accuracy is not the goal.
- New memories must be available in the next chat. Delivery stays per turn; nothing is batched or delayed to reduce volume.
- Everything works with, and is tested on, the local model. Nothing leaves the box: no hosted helper or decision model.
- Keep Hindsight as the engine. Do not rebuild the old system's machinery (write-time expiry guesses, nightly reconciliation, compound merges) inside it.
- Four kinds of memory age differently:
  1. **Lasting facts** (who you are, family, languages, values, long-held tastes) are kept until something replaces them.
  2. **Current situation** (where you study, your parents' home, your main projects) can have several values true at once. When one changes, the new one is current and the old one becomes dated history, available if needed, never presented as now.
  3. **Temporary states** (sick, a toothache, an exam next week) stop being brought up on their own after days or weeks, without the person saying they are over; afterwards a dated line of history.
  4. **One-off chat details** (brainstorming steps, a question asked, reactions to Alfy's suggestions) are not memories, except a lasting outcome.
  - Projects sit between 2 and 3: active while talked about, quiet when not, back the moment they are mentioned again. Nobody has to close a project.
- The Memory page uses **layout C, a subject index** (phone mockups 3 and 4, the Overview sheet 6 and 7, desktop 8 to 10; images are in this design's conversation, not in the repo).
- **An Overview of the person comes back**, behind one row at the top, written only when opened, never refreshed in the background and never fed to chats (mockups 6 and 7).
- **The new subjects need a migration for every user's existing entries. The tester account (tester@tester.com) is excluded from it, and from every Memory migration, forever.**
- Recall must be fair to projects; model calls must wait their turn instead of failing; jobs must wait for Hindsight to finish; migration follow-ups only matter while accounts move between systems.
- Order: (1) fair, time-aware recall; (2) what is remembered, the labels and the page; (3) model access that waits and jobs that wait; (4) retiring what migration no longer needs.
- Ruled out: Hindsight mental models and Reflect for this purpose (they summarise on top and remove nothing; refreshes keep up to 50 stored versions including removed text; Reflect cannot be limited to given entries and bypasses our filtered recall), TTL or expiry jobs, nightly reconciliation, a merge or canonicaliser engine, entry caps, the validator veto hook, and any hosted helper.

## The idea that holds it together

**Never delete on a guess; decide at read time.** The old system guessed an expiry when it saved a fact, without ever telling the model the date (its judge prompt carried no dates; reconcile sent facts without dates), then deleted on the guess. Hindsight records real dates: each fact's assertion date, and an entry's `mentioned_at`, which moves forward when the subject is mentioned again (`engine/memories/pg/consolidation.py:300-303`). So the system keeps what Hindsight stores and decides, when recall and the page read it, what counts as current. A rule that is too eager loses nothing. Storage still grows slowly; what stays small is what the person sees and what Alfy brings up.

## Goals

- In a project chat, the project's own entries reach the model (sales unblocked).
- Proactive recall carries only current information, with each entry's age and kind visible to the model.
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
- Anything that needs a smarter model than ours, or any data leaving the box.
- The tester account touched by any migration.

## Constraints

- Local model only (Flash-Next on the box). Every behaviour is accepted on it, with synthetic data only (never real users' data).
- One inference slot by day, six overnight (`deploy/hindsight/README.md`); any added model call competes with the person's next turn. Prefer zero added calls per turn.
- Project memory never leaves its project; personal memory may accompany any chat.
- All model-facing text is English (ruling 79, `src/lib/server/services/chat-turn/AGENTS.md`); UI text is English and Hungarian.
- Bank configuration changes reach every bank: `verifyConfig` compares each key (`hindsight-client.ts:267-274`), and array or object keys need deep comparison.
- Repository gates, an independent Opus review per part, paired backups and canonical tools for anything run on production. Production deploys only on the owner's word.

## The design, in delivery order

### 1. Fair, time-aware recall

Today: banks are recalled in order (personal, then the current project) and each fills one shared budget until it is gone. Rows reach the model as bare text with no date.

New behaviour:

- **A fair split.** In a project chat, recall reserves a share of the budget for the project bank, then fills the rest by relevance across both banks. If the project has fewer relevant entries than its share, personal entries use the remainder. A personal chat is unchanged (personal bank only).
- **Current only, proactively.** Entries that are "Earlier" (see part 2: superseded history, and temporary or quiet things past their age) are not offered proactively. History stays reachable through the existing deliberate past-chat search when the person asks (owner direction recorded in `docs/plans/hindsight-memory/scope-boundary.md`).
- **Age and kind visible.** Each recalled row carries its kind and how long ago it was last mentioned (for example "temporary, said 3 weeks ago"), so the model can judge relevance with the clock it already has (`normal-chat-context.ts`, `buildTimeContextLine`). The old system's time failures came from giving the model no dates.
- **Budget** stays the configured recall budget (config-store); the project share and the age thresholds are config-store settings with defaults (see "Calls I made").

Part 1 can ship before part 2 lands: until labels exist, every entry counts as lasting, so the fair split alone unblocks sales; the Earlier rules switch on as labels arrive.

Acceptance (local model, synthetic data): an account shaped like sales (about 400 personal, 100 and 90 project entries) gets project entries in every project chat where they are relevant, and an exact-text query returns its project entry; personal-only chats return the same rows as before; the post-cutover recall check (`rollout-recall.mts`) passes for sales.

### 2. What gets remembered, and how it is labelled

**Extraction (retain mission, config only).** Add to the retain mission that requests to Alfy, reactions to its suggestions and the intermediate steps of a brainstorm or a choice are not memories; when a choice settles, its outcome is, if it is likely to matter beyond the chat. Hindsight's concise mode already asks "useful in 6 months?" (`engine/retain/fact_extraction.py:1146-1166`); the mission takes priority (`:1813-1830`). Check with `POST /memories/dry-run-extract` (already wired, persists nothing) before rollout.

**Consolidation (observations mission, config only).** Add that when a later statement settles an earlier wish or plan about the same thing, only the settled state is kept; a real-world change (a move, a new job) keeps the previous state as "until <date>". Keep "one subject and one facet": grouping happens on the page, not in storage, because the facet rule was tuned for small models and our correction and withdrawal guarantees depend on it. Check with `POST /prompts/preview` (renders the exact prompt, no model call).

**Two labels, assigned inside the extraction Hindsight already runs** (no new pipeline, no added call). Hindsight's per-bank `entity_labels` classify each fact during extraction and write the label to the fact's tags (`fact_extraction.py:1696-1702, 3879-3897`; docs `api/memory-banks.mdx:142-190`):

- **Kind:** lasting, ongoing or temporary.
- **Subject:** one of a fixed short list per bank type (see "Calls I made"). Free-form topics were rejected: they would bring the pile back one level up (a subject per game character, per tool).

Under our untagged `shared` observation scope, observations carry no tags, so an entry takes its kind and subject from its supporting facts (the most recent fact wins on a disagreement); `NativeMemory` gains a `tags` field. The label is also a graph entity in Hindsight; its effect on recall must be measured.

**Earlier.** An entry is "Earlier" when it is superseded history (Hindsight's earlier-state notes, max 3 per entry, today stripped by `splitNativeNotes`, plus the 50-snapshot `GET /memories/{id}/history`), or temporary and not mentioned for longer than the temporary threshold, or ongoing and not mentioned for longer than the quiet-project threshold. A lasting entry is never Earlier unless replaced. Re-mention moves `mentioned_at` forward, so a project comes back by itself.

### 3. The Memory page (layout C) and the Overview sheet

- **Top:** the Personal/Project selector and Add, as today.
- **Overview row:** closed until opened. Opening shows a sheet (centred dialog on a computer): "Writing your overview…" from N current entries, then a short paragraph, "Written just now from your N current entries. It is written again whenever your Memory changes, and it is never sent to chats.", with Rewrite and Done.
- **Search,** as today.
- **Subject index:** one row per subject with a count and a one-line preview (the subject's most recent current entry); subjects with no current entries are hidden. "Projects" shows how many are active.
- **An opened subject:** its current entries, most recently mentioned first, each with when it was last mentioned. A changed entry shows its earlier state on a quiet line ("Earlier: lived in Budapest, until September 2025"). Ongoing entries show "active" or "quiet N weeks". The subject's own "Earlier" row folds its history and temporary things.
- **An "Earlier" row on the index** folds everything Earlier across subjects.
- **On a computer** the index shows as tiles, and an opened subject sits beside the index in a second pane (mockups 8 and 9); the Overview is a centred dialog (mockup 10).
- **Editing and removing** stay on the entry, with today's dialogs and guarantees.
- **Strings** in English and Hungarian; the Feature Guide entry for Memory updated in the same change (`src/lib/components/guide/`).

**The Overview** is written by one call to our local model over exactly the entries the page shows as current for that scope, through the app's own model-call path (sampling via `resolveModelCallSampling`, English prompt, written in the person's language). It is kept until any entry in the scope changes, then discarded; Clear Memory, account erasure and scope moves delete it; it is never stored with copies of earlier versions and never sent to chats. Hindsight mental models and Reflect are not used (see "What the owner decided").

### 4. Model access that waits, and jobs that wait for Hindsight

- **A queuing admission gateway.** Over-budget model calls wait in a bounded, fair queue (live turns before background work, fair across tenants and between Hindsight's calls and the app's own memory calls) instead of a 429. Then native fan-out can rise again from today's 1, and the engine's retries can return near the default from today's 12, each only as measurements allow.
- **Jobs that wait on Hindsight's own operation state.** Retain, consolidation and capture wait until Hindsight reports the operation terminal, within long bounded deadlines set through config-store, and time spent waiting does not consume a job's attempts.
- **Resubmit-once follow-ups** (review of `73362c397`): delay the resubmit so it does not meet the same refusal (S1); record the terminal end on the revision so a forgotten operation cannot be sent a third time (S2); tests with a real chat context envelope (S3); nits N1 to N6.
- **Canonical operator tools** for what was hand-run this weekend (resend, reattach, consolidation recover through Hindsight's `POST …/consolidation/recover`), a drain that reports every step and continues past holds and timeouts with a summary, and `cc-run-one-approved.py`-style output that names the failing step.

### 5. Retiring what migration no longer needs

After the last rollback window closes (sales: 22 December 2026; verify each account's `rollbackUntil` first):

- Remove the legacy memory system for migrated accounts (judge, nightly consolidation, the projection's write paths) and the migration-only machinery and operator scripts (prepare and rewind for migration, correction holds, the meaning-check approval tooling, `cc-*` scripts), keeping everything live accounts use: per-turn delivery, curation (edit, remove, add), publication, recall, the imported-history take-up and the history rules it relies on, Clear Memory and erasure.
- New accounts start on native Memory.
- The meaning-check follow-ups (withdraw-and-hold for a permanent forget failure; two approvals against the wrong baseline; a recorded pass surviving a return to baseline; fresh evidence for the new-assertion check; the repeated plan call) are retired with the tooling. If any new approval is needed before retirement, fix "two approvals against the wrong baseline" first.
- The tester account stays excluded from every Memory migration, by a permanent rule rather than an operator remembering it.

## The label migration for existing entries

Every existing entry needs a kind and a subject, for every user except the tester (excluded permanently).

- One-time, resumable, per account, on the local model, at background priority and inside the admission queue (part 4), overnight by default.
- Never changes an entry's text, support, dates or visibility; only adds labels where the app reads them for new facts, so old and new entries read the same way.
- Canonical tooling: dry run first (counts only), paired backups, verify per account before the next, a counts-only report (entries labelled per kind and per subject), the owner's go-ahead before production.
- Mechanism left to the builder, with these limits: re-extracting documents through Hindsight (`reprocess`) is out, because it regenerates entries and their identities; the choice is between writing tags to Hindsight's facts (if the API allows) and an app-side label store keyed by fact, read through one path for old and new facts.

## Testing and acceptance

All on the local model, synthetic data only (English and Hungarian), through the repository gates and an independent Opus review per part.

- **Recall:** the sales-shaped account above; personal chats unchanged; Earlier entries never offered proactively; rows carry age and kind.
- **Extraction:** a fixed set of synthetic brainstorms, decisions and question-only chats; facts and entries per turn measured before and after (target: a settled brainstorm leaves at most its outcome; question-only chats leave nothing).
- **Labels:** a labelled synthetic set; proposed targets 85% for kind and 80% for subject, owner may change them.
- **Time:** temporary entries leave proactive recall and fold after the threshold; a quiet project is marked and folds; one mention brings it back.
- **Overview:** written only from the visible entries; after a removal, a rewrite never contains the removed text; nothing stored after an entry change.
- **Page:** end-to-end spec for the index, an opened subject, Earlier and the Overview sheet, on a phone and a desktop, in both languages.
- **Infrastructure:** with the model held busy, no Memory call fails with 429 and no job ends `native_operation_timeout` while Hindsight is still working.
- **Label migration:** dry run on a copy; per-account verification; the tester untouched.

## Calls I made (the owner may change any of them)

1. **Subject lists.** Personal: About you, Home and family, Work and study, Health, Projects, Interests. Project banks: Goals and decisions, People, Facts and figures, Plans and status, Other.
2. **Age thresholds:** a temporary entry is Earlier after 3 weeks without a mention; an ongoing one shows "quiet" after 3 weeks and is Earlier after 3 months. Config-store settings.
3. **Project share:** half the recall budget in a project chat, config-store setting.
4. **Proactive recall carries no Earlier entries**; history only through the deliberate past-chat search.
5. **The Overview** is kept until an entry changes and is written in the person's language.
6. **New accounts start on native Memory** once part 5 lands.

## Left to the builder

- Exact mission wording (tested with dry-run extraction and prompt preview on the local model).
- Where labels live (Hindsight tags or an app-side store), within the rules above.
- How relevance is merged across banks within the fair split.
- The admission queue's mechanics (bounded wait, fairness, live first).
- Visual details within layout C, matching the app's tokens and the drawing kit.
- How part 5 is staged and tested.

## Evidence and references

- Hand-over: side-session notes `hindsight-rearchitecture-handover-2026-11-22.md` (production state, sales record, system issues 2.1 to 2.6).
- Our test evidence: `docs/plans/hindsight-memory/` (integrated benchmark, current-list follow-up, fit investigation, capacity results, `ui-inventory.md`).
- Hindsight at pin `9fb28dbd`: consolidation rules `engine/consolidation/prompts.py`; consolidator `engine/consolidation/consolidator.py`; extraction `engine/retain/fact_extraction.py`; recall reranking `engine/search/reranking.py`; mental models `engine/memory_engine.py`, `engine/mental_model_refresh.py`.
- Current code: recall `src/lib/server/services/memory-context/native.ts`; bank config `src/lib/server/services/memory-profile/contracts.ts`; client `hindsight-client.ts`; delivery `delivery-runner.ts`; admission `deploy/hindsight/alfyai_admission.py`.
