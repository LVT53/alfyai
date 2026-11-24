# Memory redesign, part 1: fair, message-aware recall — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every chat's memory recall carries the person's basics plus what their message is about, a project chat keeps at least half of it for the project's own entries, and each recalled row tells the model when it was last said, all within the section's budget.

**Architecture:** `recallMemory` (`src/lib/server/services/memory-context/native.ts`) keeps its per-bank verification of Hindsight rankings exactly as it is. Through one client per bank it runs one Hindsight search per query (the message; on the per-turn path also a fixed core query), turns each verified ranking into a candidate list, and hands the lists to a pure allocator (`allocateRecall`) that fills capped lanes, taking from a lane's lists in turn, and then spills leftovers. One formatter (`formatRecalledMemory`) writes the rows for both callers, the per-turn section (`chat-turn/context-selection.ts`) and the `memory_context` tool (`memory-context/persona.ts`), and every row is counted as its whole formatted line. The two shares are runtime settings (`env.ts` → `config-store.ts` → admin registry).

**Tech Stack:** SvelteKit server code in TypeScript, Drizzle on better-sqlite3, Vitest, the Hindsight HTTP client (`memory-profile/hindsight-client.ts`), Biome, Fallow.

**Spec:** `docs/superpowers/specs/2026-11-22-memory-redesign-design.md`, part 1 ("Fair, time-aware recall"), with its Goals, Constraints and "Calls I made" 4 and 6. Parts 2 to 5 get their own plans once this one ships. An independent Opus review of the first draft (23 November 2026) is folded in.

## Global Constraints

- Before touching code, check the current Vitest docs (module mocks with `importOriginal`, `vi.hoisted`, `it.each`) and Drizzle's better-sqlite3 transactions, through Context7 or the official docs, and say in the task report which docs were checked (root `AGENTS.md`, "Mandatory Docs Check").
- Tests use synthetic data only, never a real person's memories or chats.
- Hindsight recall makes no model call (dateparser, the embedder and the BGE reranker; no decision model is configured), so a second search per bank costs no inference slot. This plan adds no model call. Hindsight parses dates in a query on one CPU worker, up to about 1.3 s on document-sized text (`engine/search/retrieval.py`, `resolve_temporal_constraint`, at pin `9fb28dbd`), which is why a long message is cut hard.
- Project memory never leaves its project; personal memory may accompany any chat.
- Everything written into a model request is ASCII English, with no language name and no reply-language instruction (ruling 79, `src/lib/server/services/chat-turn/AGENTS.md`, invariants I1 and I3). The ruling-79 integration tests seed legacy memory and never render the native section, so this plan's own tests check its words.
- A runtime setting goes through `env.ts` (default), `config-store.ts` (override), the admin registry with English and Hungarian words, `.env.example`, `docs/configuration.md` and `README.md` (root `AGENTS.md`, "If you add a new runtime-configurable setting").
- Defaults: core share 25 percent (spec: "at most a quarter"), project share 50 percent (spec: "half the budget"); both integers from 0 to 100. If they add up to more than 100 the project lane fills first.
- The memory section is protected and always goes into the prompt whole (`src/lib/server/utils/prompt-context.ts:585`), so recall counts every row as its whole formatted line (`recallLineTokens`) and reserves the project heading: the formatted section never exceeds the budget it was given.
- One clock per turn: the ages in a turn are computed from the turn's `turnNow` (`normal-chat-context.ts:2188`), so a rebuild after automatic compression writes identical text.
- Until labels exist (part 2) nothing is Earlier, and a row shows its age without a kind.
- Recall writes nothing: being recalled changes no stored row.
- Every bank keeps the 2-second bound of `AbortSignal.timeout(2_000)`; banks are searched one after another, as today.
- An entry with no dated source gets no age; never invent "today" for an undated fact (`memory-profile/AGENTS.md`).
- The person's message now reaches Hindsight as a recall query. Hindsight's info logs include recall queries, so its logger stays at warning (`deploy/hindsight/compose.yaml:30`, `deploy/hindsight/README.md:15`).
- Run commands from the worktree with Node 22 first on `PATH` (`export PATH=/opt/homebrew/opt/node@22/bin:$PATH`). `npm run check` stays at 0 errors and 0 warnings, `npx biome check src scripts tests` is clean, Fallow reports no new finding, and the build has zero warnings.
- Commit only your task's files: `git commit ... -- <paths>`.
- Nothing in this plan is pushed or deployed. Box runs and production steps need the owner's word.

## Review Focus

1. **A short follow-up** ("yes, do that", "and the second one?"): it names no topic, so a message of fewer than four words is searched together with the chat's title; the core still fills its share. Test: Task 5, "adds the chat's title to a short follow-up".
2. **A message with no words** (a picture or a file sent alone): the title alone is searched when the chat has one, otherwise no message search runs; the core and the project's general entries fill the section. Test: Task 5, "uses the title alone for a message with no words" and "keeps the basics when the message has no words".
3. **A long pasted message:** the search query is cut to its first 300 and last 200 characters, so date parsing and reranking stay inside the timeout. Test: Task 5, "cuts a long message to its start and end" and "cuts a long message before searching"; Task 7 times 500-character messages.
4. **One of a bank's searches, or its evidence snapshot, failing or timing out:** the search that answered is still used and nothing it did not rank is added; a failed snapshot keeps the answered rankings without evidence, as today; only when every search of a bank fails does the bank fall back to its accepted rows in stored order. Test: Task 5, "uses the search that answered when the other fails" and "keeps the answered rankings when the evidence snapshot fails".
5. **A project with few or no entries:** its unused share goes to the person's entries, so no budget is wasted. Test: Task 3, "passes an unused project share on"; Task 4, "fills the rest with personal entries when the project has few".

## Order and parallel work

Tasks 1, 2 and 3 touch disjoint files. They may run side by side only in separate worktrees branched from this plan's commit, merged back one at a time before Task 4; in one worktree they run in sequence, because a commit or a type check would see another task's half-made work. Task 4 needs all three, Task 5 needs Task 4, Task 6 runs the gates once at the end, and Task 7 is the owner-approved run on the box.

---

### Task 1: Show when each entry was last said, within the budget, on the turn's clock

**Files:**
- Create: `src/lib/server/services/memory-context/recall-format.ts`
- Create: `src/lib/server/services/memory-context/recall-format.test.ts`
- Modify: `src/lib/memory-types.ts:81-85` (`AdmittedMemoryEvidence`)
- Modify: `src/lib/server/services/memory-context/native.ts:155-314` (the budget fill and the output loop)
- Modify: `src/lib/server/services/memory-context/native.test.ts`
- Modify: `src/lib/server/services/memory-context/persona.ts:175-177`
- Modify: `src/lib/server/services/chat-turn/context-selection.ts` (`buildConstructedContext` params, `buildActiveMemoryProfilePromptSection` at lines 396-439, its two calls at lines 1649 and 2360)
- Modify: `src/lib/server/services/chat-turn/context-selection.test.ts`
- Modify: `src/lib/server/services/normal-chat-context.ts` (`turnNow` at line 2188, `constructedContextParams` at line 2163)
- Modify: `src/lib/server/services/normal-chat-context.test.ts`
- Modify: `src/lib/server/services/memory-context.persona-v2.test.ts`

**Interfaces:**
- Produces: `AdmittedMemoryEvidence.lastMentionedAt: string | null`, an ISO 8601 instant: the newest `explicitEditAt ?? assertedAt` among the sources of the entry's admitted supporting facts, or `null` when it has none.
- Produces, in `recall-format.ts`: `formatRecalledMemory(items: readonly AdmittedMemoryEvidence[], now: Date): string`; `recallLineTokens(text: string): number`, equal to `estimateTokenCount(text) + 9`, the most a row's line can cost; `RECALL_PROJECT_HEADING = "Remembered for this project:"`. The age helper stays private.
- Produces: `buildConstructedContext({ ..., now?: Date })`. Without `now` it reads the clock once at its top.

Exact row format: each row is `- ${text}`, followed by ` (${age})` when the entry has a usable date. The person's rows come first, in input order. When any project row exists, `RECALL_PROJECT_HEADING` follows on its own line, then the project rows in input order. The age comes from elapsed whole days `d = Math.floor((now - lastMentionedAt) / 86_400_000)`, a future instant counting as `d = 0`:

| d | age |
|---|---|
| 0 | `said less than a day ago` |
| 1 | `said 1 day ago` |
| 2 to 13 | `said ${d} days ago` |
| 14 to 59 | `said ${Math.floor(d / 7)} weeks ago` |
| 60 to 729 | `said ${Math.floor(d / 30)} months ago` |
| 730 and more | `said ${Math.floor(d / 365)} years ago` |

A `null` or unparseable `lastMentionedAt` gives no suffix. The longest suffix, "less than a day ago", costs 9 tokens with the leading `- `.

- [ ] **Step 1: Write the failing formatter tests** in `recall-format.test.ts`

```ts
const now = new Date("2026-11-23T12:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
const item = (text: string, lastMentionedAt: string | null, kind: "personal" | "project" = "personal") =>
	({
		ref: { scope: kind === "personal" ? { kind } : { kind, projectId: "p" }, generation: "g", rowId: text },
		text,
		sources: [],
		lastMentionedAt,
	}) as AdmittedMemoryEvidence;

it("says when each entry was last said", () => {
	expect(formatRecalledMemory([0, 1, 3, 13, 14, 59, 60, 729, 730].map((d) => item(`d${d}`, daysAgo(d))), now)).toBe(
		[
			"- d0 (said less than a day ago)",
			"- d1 (said 1 day ago)",
			"- d3 (said 3 days ago)",
			"- d13 (said 13 days ago)",
			"- d14 (said 2 weeks ago)",
			"- d59 (said 8 weeks ago)",
			"- d60 (said 2 months ago)",
			"- d729 (said 24 months ago)",
			"- d730 (said 2 years ago)",
		].join("\n"),
	);
});
it("gives an undated entry no age and counts a future date as less than a day", () => {
	expect(formatRecalledMemory([item("undated", null), item("bad", "not a date"), item("future", daysAgo(-2))], now)).toBe(
		"- undated\n- bad\n- future (said less than a day ago)",
	);
});
it("puts the project's entries after the person's, under their own line", () => {
	expect(
		formatRecalledMemory([item("Project A", null, "project"), item("Likes tea", null), item("Project B", null, "project")], now),
	).toBe("- Likes tea\nRemembered for this project:\n- Project A\n- Project B");
});
it("never costs more than recallLineTokens for a row", () => {
	for (const d of [null, 0, 1, 5, 20, 100, 800]) {
		const line = formatRecalledMemory([item("Prefers green tea", d === null ? null : daysAgo(d))], now);
		expect(estimateTokenCount(line)).toBeLessThanOrEqual(recallLineTokens("Prefers green tea"));
	}
	expect(estimateTokenCount(formatRecalledMemory([item("Prefers green tea", daysAgo(0))], now))).toBe(
		recallLineTokens("Prefers green tea"),
	);
});
it("adds only ASCII words that name no language and give no reply instruction", () => {
	const out = formatRecalledMemory(
		[0, 1, 3, 20, 100, 800].flatMap((d) => [item("x", daysAgo(d)), item("y", daysAgo(d), "project")]),
		now,
	);
	expect(/^[\x20-\x7e\n]*$/.test(out)).toBe(true);
	expect(out).not.toMatch(/\b(english|hungarian|magyar|angol|language|languages|reply|replies|respond|answer)\b/i);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/lib/server/services/memory-context/recall-format.test.ts`
Expected: FAIL, the module `./recall-format` does not exist.

- [ ] **Step 3: Implement `recall-format.ts` and add `lastMentionedAt: string | null` to `AdmittedMemoryEvidence`**

- [ ] **Step 4: Write the failing recall tests** in `native.test.ts`

Source revisions need distinct event ids (unique index `memory_source_event_idx` on user and event, `schema.ts:3401`), so `seed()` stays as it is and this test writes its own rows: bank `b1` (scope `personal`); source `s1` (event and lineage `e-b1-1`, `assertedAt` `2026-10-01T00:00:00Z`) acknowledging fact `f1`; source `s2` (event and lineage `e-b1-2`, `assertedAt` `2026-11-01T00:00:00Z`, `explicitEditAt` `2026-11-10T00:00:00Z`) acknowledging fact `f2`; one published row with `sourceIdsJson` `["f1","f2"]` and both facts in `sourceFingerprintsJson`.

1. "reports the newest date among an entry's sources": recall offline (the default mock); `result[0].lastMentionedAt === "2026-11-10T00:00:00.000Z"`.
2. "fits the formatted section in its budget": chat `c` (project `p`), `seed("b1", "personal", "Personal preference")` and `seed("b2", "project:p", "Project decision")`, recall offline. With `B = recallLineTokens("Personal preference") + recallLineTokens("Project decision") + estimateTokenCount(RECALL_PROJECT_HEADING)` both entries come back and `estimateTokenCount(formatRecalledMemory(result, new Date()))` is at most `B`; with `B - 1` only the personal entry comes back, and the formatted text is at most `B - 1`.

- [ ] **Step 5: Run them to see them fail**

Run: `npx vitest run src/lib/server/services/memory-context/native.test.ts`
Expected: FAIL on the two new tests.

- [ ] **Step 6: Change `recallMemory`'s budget and output**

While the output loop builds `sources` from a row's admitted facts, keep the largest `(fact.source.explicitEditAt ?? fact.source.assertedAt).getTime()` and push it as ISO, or `null` when the row has no admitted fact. Count a row as `recallLineTokens(row.text)`, not `estimateTokenCount(row.text)`. In a project chat start the budget at `B - estimateTokenCount(RECALL_PROJECT_HEADING)`.

- [ ] **Step 7: Use the formatter, on the turn's clock, in both callers**

- `buildConstructedContext` takes `now?: Date` (read once at its top when absent) and passes it to `buildActiveMemoryProfilePromptSection`, whose native branch writes `formatRecalledMemory(recalled, now)` and asks for `tokenBudget: Math.max(0, baselineMemoryProfileBudget.totalBudget - estimateTokenCount(ACTIVE_MEMORY_PROFILE_NOTE))`, so the note and the rows together fit the section's budget.
- In `normal-chat-context.ts`, move `const turnNow = new Date();` above `constructedContextParams` (line 2163) and put `now: turnNow` in that object. The automatic-compression rebuild spreads the same object (line 1618), so both builds of a turn use one clock.
- In `persona.ts:175-177`, the native branch's `content` is `formatRecalledMemory(recalled, new Date())` when anything was recalled, else `null`.

- [ ] **Step 8: Write the failing caller tests**

In `context-selection.test.ts`, add `usesNativeMemory` and `recallMemory` to the hoisted `mocks`; mock `"../memory-profile/chat-delivery"` with `importOriginal` spread and `usesNativeMemory: mocks.usesNativeMemory`; mock `"../memory-context/native"` as `() => ({ recallMemory: mocks.recallMemory })` (it exports nothing else). `resetConstructedContextMocks()` sets `usesNativeMemory` to return `false` and `recallMemory` to resolve `[]`, so every existing test keeps the legacy path. New test, "shows when each remembered entry was last said": `usesNativeMemory` returns `true`, `isMemoryActiveForConversation` resolves `true`, `recallMemory` resolves one personal entry `"Prefers green tea"` with `lastMentionedAt` `"2026-11-20T11:00:00.000Z"`; `buildConstructedContext({ userId: "user-1", conversationId: "conversation-1", message: "What should I drink this afternoon?", modelId: "local-model", now: new Date("2026-11-23T12:00:00Z"), contextLimits: { maxModelContext: 16_000, compactionUiThreshold: 12_000, targetConstructedContext: 8_000 } })`; `inputValue` contains `"## Remembered information"` and `"- Prefers green tea (said 3 days ago)"`.

In `normal-chat-context.test.ts`, in an existing automatic-compression test (one where `mocks.buildConstructedContext` is called twice in one turn), assert both calls carry a `now` with the same instant.

In `memory-context.persona-v2.test.ts`, mock `"./memory-context/native"` as `() => ({ recallMemory: mocks.recallMemory })` with a hoisted mock; new test, "the native tool says when each entry was last said": `usesNativeMemory` returns `true` for this test, `recallMemory` resolves one personal entry `"Prefers green tea"` with `lastMentionedAt` 36 hours before `Date.now()`; `result.content === "- Prefers green tea (said 1 day ago)"`.

- [ ] **Step 9: Run the tests**

Run: `npx vitest run src/lib/server/services/memory-context/recall-format.test.ts src/lib/server/services/memory-context/native.test.ts src/lib/server/services/chat-turn/context-selection.test.ts src/lib/server/services/normal-chat-context.test.ts src/lib/server/services/memory-context.persona-v2.test.ts && npm run check`
Expected: all PASS; check reports 0 errors and 0 warnings.

- [ ] **Step 10: Commit**

```bash
paths=(src/lib/memory-types.ts src/lib/server/services/memory-context/recall-format.ts src/lib/server/services/memory-context/recall-format.test.ts src/lib/server/services/memory-context/native.ts src/lib/server/services/memory-context/native.test.ts src/lib/server/services/memory-context/persona.ts src/lib/server/services/chat-turn/context-selection.ts src/lib/server/services/chat-turn/context-selection.test.ts src/lib/server/services/normal-chat-context.ts src/lib/server/services/normal-chat-context.test.ts src/lib/server/services/memory-context.persona-v2.test.ts)
git add "${paths[@]}"
git commit -m "Show the model when each remembered entry was last said" -m "Recalled rows reached the model as bare text, so a toothache from March read as current as a sister. Each row now says when it was last said, from its newest source date and the turn's one clock, and a project's entries sit under their own line. Rows are counted as their whole line, because the memory section always goes into the prompt whole and the age text would otherwise push it past its budget." -- "${paths[@]}"
```

---

### Task 2: Two recall shares as runtime settings

**Files:**
- Modify: `src/lib/server/env.ts` (the env config type near line 86, the parse near line 741)
- Modify: `src/lib/server/config-store.ts` (the admin key list near line 136, `RuntimeConfig` near line 256, the defaults near line 420, the apply map near line 1111, the string projection near line 1925, and a new getter)
- Modify: `src/lib/config/admin-config-registry.ts` (the memory group, near line 391)
- Modify: `src/lib/i18n/settings.ts` (English near line 1714, Hungarian near line 3936)
- Modify: `.env.example` (the Hindsight block, lines 473-489)
- Modify: `docs/configuration.md` (the memory keys near line 139)
- Modify: `README.md` (the Hindsight paragraph ending at line 269)
- Test: `src/lib/server/config-store.memory-v2.test.ts`, `src/lib/server/config-store.promoted-keys.test.ts`

**Interfaces:**
- Produces: `getMemoryRecallShares(): { corePercent: number; projectPercent: number }`, exported from `src/lib/server/config-store.ts`, reading `getConfig().memoryRecallCorePercent` and `getConfig().memoryRecallProjectPercent`.
- Keys: `MEMORY_RECALL_CORE_PERCENT` (default 25) and `MEMORY_RECALL_PROJECT_PERCENT` (default 50), integers from 0 to 100. A value outside that range or not an integer is ignored: the environment falls back to the default, an admin override leaves the current value.

- [ ] **Step 1: Write the failing tests**

In `config-store.memory-v2.test.ts` (add both keys to the `afterEach` cleanup list):

```ts
it("recall shares default to a quarter for the basics and half for a project", async () => {
	const { getMemoryRecallShares } = await import("./config-store");
	expect(getMemoryRecallShares()).toEqual({ corePercent: 25, projectPercent: 50 });
});
it("recall shares come from the environment and ignore values outside 0 to 100", async () => {
	process.env.MEMORY_RECALL_CORE_PERCENT = "40";
	process.env.MEMORY_RECALL_PROJECT_PERCENT = "250";
	const { getMemoryRecallShares } = await import("./config-store");
	expect(getMemoryRecallShares()).toEqual({ corePercent: 40, projectPercent: 50 });
});
```

In `config-store.promoted-keys.test.ts`, which already mocks `./db` and the available models, using its way of applying admin overrides: an override of `MEMORY_RECALL_PROJECT_PERCENT` = `"60"` gives `projectPercent: 60`; `"abc"` and `"101"` leave it at 50.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/server/config-store.memory-v2.test.ts src/lib/server/config-store.promoted-keys.test.ts`
Expected: FAIL, `getMemoryRecallShares` is not exported and the override keys are unknown.

- [ ] **Step 3: Implement the two keys along the existing memory pattern** (`MEMORY_JUDGE_IDLE_MINUTES` is the model in each file)

Registry entries: `{ key: "MEMORY_RECALL_CORE_PERCENT", group: "memory", control: int(0, 100), effect: "live" }` and the same for `MEMORY_RECALL_PROJECT_PERCENT`. There is no percent unit, so the labels carry "(%)".

Exact words:

| Key | English label | English meaning | Hungarian label | Hungarian meaning |
|---|---|---|---|---|
| `MEMORY_RECALL_CORE_PERCENT` | Basics share of recall (%) | Percent of each chat's memory space kept for the person's basics. | Alapadatok aránya (%) | A beszélgetésenkénti memóriakeret hány százaléka jut a személy alapadataira. |
| `MEMORY_RECALL_PROJECT_PERCENT` | Project share of recall (%) | In a project chat, percent of the memory space kept for that project's own memories. | Projekt aránya (%) | Projektbeszélgetésben a memóriakeret hány százaléka jut a projekt saját emlékeire. |

`.env.example`, at the end of the Hindsight block (lines 473-489):

```
# Native Memory recall: percent of each chat's memory space kept for the person's basics (0-100)
MEMORY_RECALL_CORE_PERCENT=25
# Native Memory recall: in a project chat, percent kept for the project's own memories (0-100)
MEMORY_RECALL_PROJECT_PERCENT=50
```

`docs/configuration.md`: both keys beside the memory keys near line 139, in that file's format, with the defaults and the 0 to 100 range.

`README.md`, appended to the paragraph that ends at line 269: "Native recall shares each chat's memory space: `MEMORY_RECALL_CORE_PERCENT` (default 25) is kept for the person's basics and, in a project chat, `MEMORY_RECALL_PROJECT_PERCENT` (default 50) for that project's own memories; what the message is about fills the rest. Both are admin-overridable; if they add up to more than 100, the project's share fills first."

- [ ] **Step 4: Run the tests and the registry checks**

Run: `npx vitest run src/lib/server/config-store.memory-v2.test.ts src/lib/config/admin-config-registry.test.ts src/lib/server/config-store.promoted-keys.test.ts "src/routes/(app)/settings/_components/system/AdvancedPage.unwired.test.ts" && npm run check`
Expected: all PASS; check reports 0 errors and 0 warnings.

- [ ] **Step 5: Commit**

```bash
paths=(src/lib/server/env.ts src/lib/server/config-store.ts src/lib/config/admin-config-registry.ts src/lib/i18n/settings.ts .env.example docs/configuration.md README.md src/lib/server/config-store.memory-v2.test.ts src/lib/server/config-store.promoted-keys.test.ts)
git add "${paths[@]}"
git commit -m "Add admin-tunable shares for native Memory recall" -m "Recall will keep part of each chat's memory space for the person's basics and, in a project chat, for the project's own memories. The defaults follow the agreed design (a quarter and a half); the admin can tune them without a deploy." -- "${paths[@]}"
```

---

### Task 3: The allocator

**Files:**
- Create: `src/lib/server/services/memory-context/recall-allocation.ts`
- Create: `src/lib/server/services/memory-context/recall-allocation.test.ts`

**Interfaces:**
- Produces:

```ts
export interface RecallCandidate { key: string; tokens: number }
export interface RecallLane { lists: readonly (readonly RecallCandidate[])[]; capTokens: number }
export function allocateRecall(lanes: readonly RecallLane[], budgetTokens: number): string[];
```

The algorithm, because the tests alone leave the order of turns open:

1. First pass, lanes in array order. Within a lane, take from its lists in turn: list 1's next candidate, then list 2's, and so on, round after round. A list's next candidate is its first one not taken yet that fits, meaning the lane's taken tokens plus its tokens stay within `capTokens` and the total stays within `budgetTokens`; candidates passed over stay untaken. A list with no candidate that fits drops out; the lane ends when every list has dropped out.
2. Spill pass: the same walk over the lanes again, ignoring the caps and keeping only the total.
3. Return the taken keys in the order taken.

Callers order the lanes so that the spill order is right: the project lane, then the core lane, then the message lane.

- [ ] **Step 1: Write the failing tests**

```ts
const run = (prefix: string, n: number, tokens = 10) =>
	Array.from({ length: n }, (_, i) => ({ key: `${prefix}${i}`, tokens }));
const lane = (capTokens: number, ...lists: RecallCandidate[][]) => ({ lists, capTokens });

it("keeps a project's share even when the person's entries alone would fill the budget", () => {
	expect(allocateRecall([lane(50, run("j", 10)), lane(25, run("c", 10)), lane(100, run("m", 10))], 100)).toEqual(
		["j0", "j1", "j2", "j3", "j4", "c0", "c1", "m0", "m1", "m2"],
	);
});
it("passes an unused project share on", () => {
	expect(allocateRecall([lane(50, run("j", 1)), lane(25, run("c", 10)), lane(100, run("m", 10))], 100)).toEqual(
		["j0", "c0", "c1", "m0", "m1", "m2", "m3", "m4", "m5", "m6"],
	);
});
it("takes an entry that two searches found once", () => {
	const a = { key: "a", tokens: 10 }, b = { key: "b", tokens: 10 }, c = { key: "c", tokens: 10 };
	expect(allocateRecall([lane(100, [a, b]), lane(100, [b, c])], 100)).toEqual(["a", "b", "c"]);
});
it("takes from a lane's lists in turn, past what another lane took", () => {
	expect(allocateRecall([lane(40, run("j", 10)), lane(100, run("p", 10), run("j", 10))], 100)).toEqual(
		["j0", "j1", "j2", "j3", "p0", "j4", "p1", "j5", "p2", "j6"],
	);
});
it("places an entry too large for its lane in the spill pass", () => {
	expect(
		allocateRecall(
			[lane(50, [{ key: "big", tokens: 60 }, { key: "j1", tokens: 10 }]), lane(25, []), lane(100, [{ key: "m0", tokens: 10 }])],
			100,
		),
	).toEqual(["j1", "m0", "big"]);
});
it("never goes over the budget", () => {
	const lanes = [lane(60, run("j", 7, 13)), lane(30, run("c", 7, 17)), lane(100, run("m", 7, 23), run("j", 7, 13))];
	const tokens = new Map(lanes.flatMap((l) => l.lists.flat().map((c) => [c.key, c.tokens] as const)));
	expect(allocateRecall(lanes, 100).reduce((sum, key) => sum + (tokens.get(key) ?? 0), 0)).toBeLessThanOrEqual(100);
});
it("takes nothing from a zero budget", () => {
	expect(allocateRecall([lane(100, run("m", 3))], 0)).toEqual([]);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/server/services/memory-context/recall-allocation.test.ts`
Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement `allocateRecall`**

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run src/lib/server/services/memory-context/recall-allocation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
paths=(src/lib/server/services/memory-context/recall-allocation.ts src/lib/server/services/memory-context/recall-allocation.test.ts)
git add "${paths[@]}"
git commit -m "Add a lane allocator for sharing the memory recall budget" -m "Recall filled one budget bank by bank, personal first, so a large personal bank left nothing for the project in a project chat. The allocator gives each lane its own cap, takes from several ranked lists in turn, never repeats an entry two searches found, and spills what is left so no share goes unused." -- "${paths[@]}"
```

---

### Task 4: A fair split in `recallMemory`

**Files:**
- Modify: `src/lib/server/services/memory-context/native.ts:155-314` (the transaction's budget fill)
- Modify: `src/lib/server/services/memory-context/native.test.ts`

**Interfaces:**
- Consumes: `allocateRecall`, `RecallLane` (Task 3); `getMemoryRecallShares()` (Task 2); `recallLineTokens`, `RECALL_PROJECT_HEADING` and `lastMentionedAt` (Task 1).
- Produces: `recallMemory(userId, { conversationId, query, tokenBudget })`, its signature unchanged in this task. The rows it returns are chosen by the allocator; the person's entries are listed first and the project's after, each in the order chosen.

In the transaction, replace the bank-by-bank fill with three steps, `B = Math.max(0, Math.floor(tokenBudget))` and, in a project chat, `B' = B - estimateTokenCount(RECALL_PROJECT_HEADING)` (`B' = B` otherwise):

1. For each readable bank, its candidate rows in exactly the order the old code offered them (by the verified ranking when there is one, otherwise every accepted row in stored order), leaving out a row whose `sourceIdsJson` is not an array. Key `${bank.id}:${row.nativeId}`, tokens `recallLineTokens(row.text)`.
2. Lanes. In a project chat: the project lane, lists `[project rows]`, cap `Math.floor((B' * projectPercent) / 100)`; then the message lane, lists `[personal rows, project rows]`, cap `B'`. In a personal chat: the message lane alone, lists `[personal rows]`, cap `B`. Call `allocateRecall(lanes, B')`.
3. Build each chosen entry as Task 1 does, the personal bank's entries first.

The verification of each ranking (`order`, bridges, migration families, the evidence snapshot) does not change.

- [ ] **Step 1: Write the failing tests**

Test support in `native.test.ts`:
- The client mock passes the bank to the shared mock: `recall: (query: string, budget: number) => recall(query, budget, signal, bankId)`. Existing tests ignore the fourth argument.
- Mock `"$lib/server/config-store"` with `importOriginal` spread and `getMemoryRecallShares: () => shares`, where `shares` is reset to `{ corePercent: 25, projectPercent: 50 }` in `beforeEach`.
- `seedBankRows(bankId: string, scopeKey: string, texts: string[])`: one bank, then per text `i` an accepted source revision `s-${bankId}-${i}` with event and lineage `${bankId}-${i}`, acknowledging fact `f-${bankId}-${i}`, and a published row with native id `n-${bankId}-${i}` supported by that fact (the fields `seed()` writes).
- `ranked(bankId: string, texts: string[], indices: number[])`: the observations Hindsight would return, `{ id: \`n-${bankId}-${i}\`, text: texts[i], fact_type: "observation", source_memory_ids: [\`f-${bankId}-${i}\`] }`. These pass the ranking check as direct matches, so no evidence snapshot is taken.

Fixtures: personal texts `Personal fact ${String(i).padStart(2, "0")}` (40 of them) in bank `bp` (scope `personal`); project texts `Project fact ${String(i).padStart(2, "0")}` in bank `bj` (scope `project:p`); the recall mock returns all of a bank's rows in order. `L = recallLineTokens("Personal fact 00")` and `H = estimateTokenCount(RECALL_PROJECT_HEADING)`; first assert the precondition `L === recallLineTokens("Project fact 00")` (both are 13), so no row size blurs the counts.

1. "gives a project chat's own entries their share even when the person's entries alone would fill it": 20 project texts, chat `c`, `B = 20 * L + H`. Exactly 15 project entries and 5 personal entries (10 from the project lane, then the message lane in turn), the personal entries first, and `estimateTokenCount(formatRecalledMemory(result, new Date()))` at most `B`.
2. "fills the rest with personal entries when the project has few": 2 project texts, chat `c`, `B = 20 * L + H`. Exactly 2 project entries and 18 personal entries.
3. "keeps a personal chat's recall in ranking order": chat `personal`, `B = 10 * L`. The entries are `Personal fact 00` to `Personal fact 09`, in that order.
4. "writes nothing while recalling": read `(sqlite.prepare("select total_changes() as n").get() as { n: number }).n` before and after a recall in chat `c`; the two are equal.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/server/services/memory-context/native.test.ts`
Expected: FAIL on tests 1 and 2 (no project entries come back); 3 and 4 may already pass.

- [ ] **Step 3: Implement the three steps above in `recallMemory`**

- [ ] **Step 4: Run the recall tests and every test that calls `recallMemory`**

Run: `npx vitest run src/lib/server/services/memory-context/native.test.ts src/lib/server/services/memory-profile/curation.integration.test.ts src/lib/server/services/memory-profile/migration.integration.test.ts && npm run check`
Expected: all PASS. A failure in an integration test is a change in behaviour to understand and report, not an expectation to edit.

- [ ] **Step 5: Commit**

```bash
paths=(src/lib/server/services/memory-context/native.ts src/lib/server/services/memory-context/native.test.ts)
git add "${paths[@]}"
git commit -m "Give a project chat's own memories their share of recall" -m "Sales has 386 personal entries and 98 and 91 project entries; recall filled the budget with personal rows and returned none of the project's, even for a project entry's exact text. The project bank now gets its configured share first, the rest is shared by both banks in turn, unused shares pass on, and personal chats are unchanged." -- "${paths[@]}"
```

---

### Task 5: Search with the person's message and keep a core of basics

**Files:**
- Create: `src/lib/server/services/memory-context/recall-query.ts`
- Create: `src/lib/server/services/memory-context/recall-query.test.ts`
- Modify: `src/lib/server/services/memory-context/native.ts`
- Modify: `src/lib/server/services/memory-context/native.test.ts`
- Modify: `src/lib/server/services/chat-turn/context-selection.ts` (`buildActiveMemoryProfilePromptSection` and its two calls)
- Modify: `src/lib/server/services/chat-turn/context-selection.test.ts`

**Interfaces:**
- Produces, in `recall-query.ts`: `CORE_MEMORY_QUERY = "Relevant user preferences, constraints and current context"` (moved from `context-selection.ts:421`), and `messageRecallQuery(message: string, title?: string | null): string | null`.
- Produces: `recallMemory(userId, { conversationId, query, tokenBudget, core?: boolean })`. With `core: true` (the per-turn section) the message search uses `messageRecallQuery(query, chat.title)` and every bank is also searched with `CORE_MEMORY_QUERY`; without it (the tool) the search uses `messageRecallQuery(query)` alone.
- Consumes: `getMemoryRecallShares()` (Task 2), `allocateRecall` (Task 3), the candidate rows and output order of Task 4.

`messageRecallQuery`, exactly:
1. `m` and `t` are the message and the title folded by `normalizeWhitespace` (`$lib/server/utils/text`). The title counts only when it is not empty and not `DEFAULT_CONVERSATION_TITLE` (`$lib/shared/conversation-title`, "New Conversation").
2. A message of fewer than four words (`m` split on spaces; an empty `m` has none) with a counting title becomes `${t}: ${m}`, or `t` alone when `m` is empty. Any other message stays `m`.
3. An empty result is `null`. A result longer than 500 characters becomes its first 300 characters, then `" ... "`, then its last 200, counted with `Array.from` so a character is never split.

Searches in `recallMemory`:
- One client per bank, as today: `nativeMemoryClient(bank.id, account.tenantId, AbortSignal.timeout(2_000))`. Its searches (the message query when not `null`; with `core`, `CORE_MEMORY_QUERY`) run concurrently through that client (`Promise.allSettled`), each with the existing before-dispatch check, so one capability check serves both. The `isStillActive` check before each bank stays, and banks stay sequential.
- Each search ends `answered`, `timed_out` (it failed and the bank's signal has aborted) or `failed`.
- The evidence snapshot (`client.list()`) is taken at most once per bank, after its searches, when any answered ranking meets the existing condition. A failed or non-unique snapshot keeps the answered rankings without confirmed evidence, as today.
- A bank whose every search failed gives its accepted rows in stored order to each of its lists. A bank with at least one answered search gives each list only the verified rows of that list's own search, which is an empty list when that search failed.
- Lanes, `B'` as in Task 4:
  - per-turn, project chat: project lane, lists `[[...project message rows, ...project core rows]]`, cap `Math.floor((B' * projectPercent) / 100)`; core lane, lists `[personal core rows]`, cap `Math.floor((B' * corePercent) / 100)`; message lane, lists `[personal message rows, project message rows]`, cap `B'`.
  - per-turn, personal chat: core lane `[personal core rows]`, cap `Math.floor((B * corePercent) / 100)`; message lane `[personal message rows]`, cap `B`.
  - tool: as in Task 4, with the message rows.
- After the transaction, one `console.info("[KNOWLEDGE_MEMORY] Recall", { mode, bank, searches, answered, timedOut, failed, slowestMs, fallback, rows })` per eligible bank. `mode` is `"turn"` or `"tool"`, `bank` is `"personal"` or `"project"`, `fallback` says whether stored order was used, and `rows` is the number of that bank's entries returned. No query, entry text or id goes into it (`services/AGENTS.md`, the `[KNOWLEDGE_MEMORY]` summaries).

In `context-selection.ts`, `buildActiveMemoryProfilePromptSection` takes `message: string`, both calls pass `message: params.message`, and the native branch calls `recallMemory(params.userId, { conversationId: params.conversationId, query: params.message, tokenBudget, core: true })`, with Task 1's budget.

- [ ] **Step 1: Write the failing query tests** in `recall-query.test.ts`

```ts
it("keeps a message's words as its query", () => {
	expect(messageRecallQuery("  What should I\n\ncook tonight? ", "Dinner ideas")).toBe("What should I cook tonight?");
});
it("adds the chat's title to a short follow-up", () => {
	expect(messageRecallQuery("yes, do that", "Kitchen plan")).toBe("Kitchen plan: yes, do that");
});
it("leaves a short message alone in a chat with no title yet", () => {
	expect(messageRecallQuery("yes, do that", "New Conversation")).toBe("yes, do that");
	expect(messageRecallQuery("yes", null)).toBe("yes");
	expect(messageRecallQuery("yes", "  ")).toBe("yes");
});
it("uses the title alone for a message with no words", () => {
	expect(messageRecallQuery("", "Kitchen plan")).toBe("Kitchen plan");
	expect(messageRecallQuery(" \n\t ", null)).toBeNull();
	expect(messageRecallQuery("", "New Conversation")).toBeNull();
});
it("keeps a message of 500 characters whole", () => {
	const message = "a".repeat(500);
	expect(messageRecallQuery(message)).toBe(message);
});
it("cuts a long message to its start and end", () => {
	expect(messageRecallQuery(`${"s".repeat(300)}${"x".repeat(5000)}${"e".repeat(200)}`)).toBe(
		`${"s".repeat(300)} ... ${"e".repeat(200)}`,
	);
});
it("cuts by characters, never inside one", () => {
	expect(messageRecallQuery("😀".repeat(1500))).toBe(`${"😀".repeat(300)} ... ${"😀".repeat(200)}`);
});
```

- [ ] **Step 2: Write the failing recall tests** in `native.test.ts` (fixtures from Task 4; chat `c` is titled "chat" and sits in project `p`)

1. "searches with the message and the core on the per-turn path": `core: true`, `query: "What should I cook tonight?"`, chat `c`. `recall` is called with `"What should I cook tonight?"` and with `CORE_MEMORY_QUERY`, for both `bp` and `bj`. With the mock returning personal indices `[0, 1]` for the core query, `[2, 3]` for the message and nothing for `bj`, the entries are `Personal fact 00`, `01`, `02`, `03`, in that order.
2. "adds the chat's title to a short follow-up": `core: true`, `query: "yes, do that"`, chat `c`; `recall` is called with `"chat: yes, do that"` and with `CORE_MEMORY_QUERY`.
3. "keeps the basics when the message has no words": insert a chat `fresh` titled "New Conversation" (no project); `core: true`, `query: "  "`. `recall` is called only with `CORE_MEMORY_QUERY`, and the core-ranked rows come back.
4. "uses the search that answered when the other fails": chat `personal`, `core: true`, `query: "What should I cook tonight?"`; the message search rejects and the core search returns personal indices `[3, 1]`. The result is exactly `Personal fact 03` then `Personal fact 01`.
5. "keeps the answered rankings when the evidence snapshot fails": in the fixture of the `it.each` at line 387 ("uses only a unique currently admitted Edit result for replacement native ranks"), mode `"exact"`, with `list` rejecting: the per-turn recall (`core: true`, the core search returning the same ranking as the message search) holds exactly the same set of entries as the tool recall with `list` rejecting.
6. "searches once with the query on the tool path": no `core`; one `recall` call per bank, with the query and no title.
7. "cuts a long message before searching": a 5,000-character `query`; the first argument `recall` receives has at most 505 characters (`Array.from(arg).length`).
8. "brings the project entry whose text the message quotes": tool path, chat `c`, 20 project texts; when the query is `"Project fact 07"` the mock ranks `bj` index 7 first. `Project fact 07` is in the result.
9. "checks permission before every search": run the `it.each` at line 293 ("checks permission at the private recall dispatch") also with `core: true`. No change allows 4 posts; "off and on" and "incognito" during the capability check allow 0; a project move during the first recall allows the personal bank's searches only (at most 2) and none for the project bank. Run the tests at lines 172 and 237 also with `core: true`, with the same expectations as today.
10. "logs one content-free line per bank": spy on `console.info`; a per-turn recall in chat `c` where the personal bank's message search waits until its signal aborts and every other search answers. The personal line carries `{ mode: "turn", bank: "personal", searches: 2, answered: 1, timedOut: 1, failed: 0, fallback: false }`, the project line `answered: 2`, and no argument of either call contains the query or `"Personal fact"`. This test waits for the real 2-second timeout, like the test at line 172.

- [ ] **Step 3: Write the failing caller tests** in `context-selection.test.ts`

11. "searches memory with the person's message and the core of basics": `usesNativeMemory` returns `true`, message `"Remind me of the plan for my kitchen."` (the word "plan" takes the deep path, `context-selection.ts:312-320`); `mocks.recallMemory` was called with `expect.objectContaining({ query: "Remind me of the plan for my kitchen.", core: true })`.
12. The same with `"Thanks, that helps."`, which takes the shallow path.

- [ ] **Step 4: Run them to see them fail**

Run: `npx vitest run src/lib/server/services/memory-context/recall-query.test.ts src/lib/server/services/memory-context/native.test.ts src/lib/server/services/chat-turn/context-selection.test.ts`
Expected: FAIL (no `recall-query` module, no `core` option, the section still sends the fixed sentence).

- [ ] **Step 5: Implement `messageRecallQuery`, the searches, the lanes and the log line in `recallMemory`, and the caller change**

- [ ] **Step 6: Run the tests and the type check**

Run: `npx vitest run src/lib/server/services/memory-context src/lib/server/services/chat-turn/context-selection.test.ts src/lib/server/services/normal-chat-context.test.ts src/lib/server/services/memory-context.persona-v2.test.ts src/lib/server/services/memory-profile/curation.integration.test.ts src/lib/server/services/memory-profile/migration.integration.test.ts && npm run check`
Expected: all PASS; check reports 0 errors and 0 warnings.

- [ ] **Step 7: Commit**

```bash
paths=(src/lib/server/services/memory-context/recall-query.ts src/lib/server/services/memory-context/recall-query.test.ts src/lib/server/services/memory-context/native.ts src/lib/server/services/memory-context/native.test.ts src/lib/server/services/chat-turn/context-selection.ts src/lib/server/services/chat-turn/context-selection.test.ts)
git add "${paths[@]}"
git commit -m "Search memory with what the person wrote, beside a core of basics" -m "Every turn searched memory with one fixed sentence, so what the person was talking about never chose what Alfy remembered. Each chat now keeps a core of the person's basics (the old fixed search, at most a quarter) and fills the rest from the person's own message: a short follow-up borrows the chat's title, a long one is cut to its start and end. Recall makes no model call; one content-free line per bank says how each search ended." -- "${paths[@]}"
```

---

### Task 6: Record the recall rules and run the gates

**Files:**
- Modify: `src/lib/server/services/memory-profile/AGENTS.md` (a new paragraph after the first paragraph of "Native replacement boundary")

- [ ] **Step 1: Add this paragraph**

> Recall (`memory-context/native.ts`, `recallMemory`) only reads, and has two callers. Every turn's section (`chat-turn/context-selection.ts`) searches each eligible bank twice through one client: with the person's message and with the fixed core query (`CORE_MEMORY_QUERY`). `messageRecallQuery` folds whitespace, adds the chat's title to a message of fewer than four words, and cuts a long message to its first 300 and last 200 characters (Hindsight parses dates in a query on one CPU worker). The `memory_context` tool searches once, with the model's query. `allocateRecall` (`memory-context/recall-allocation.ts`) shares the budget in lanes: a project chat's own entries up to `MEMORY_RECALL_PROJECT_PERCENT` (default 50), the person's basics up to `MEMORY_RECALL_CORE_PERCENT` (default 25, the per-turn section only), then both banks' message matches in turn, then what is left over. A failed search leaves the bank's other search in charge; only a bank whose searches all fail gives its accepted rows in stored order. Every row counts as its whole line (`recallLineTokens`), because the memory section always goes into the prompt whole. Rows reach the model through `formatRecalledMemory` (`memory-context/recall-format.ts`): the person's entries, then the project's under their own line, each with when it was last said (its newest source date, on the turn's one clock). Each call logs one content-free `[KNOWLEDGE_MEMORY] Recall` line per bank. Recall writes nothing: being recalled never keeps an entry current. The person's words now reach Hindsight as recall queries, so its logger stays at warning (`deploy/hindsight/compose.yaml`, `HINDSIGHT_API_LOG_LEVEL`).

- [ ] **Step 2: Run the whole gate once**

Run: `scripts/gates.sh agent "$TMPDIR/alfyai-gates-recall" --port 4700 tests/e2e/chat.spec.ts tests/e2e/streaming.spec.ts tests/e2e/conversation.spec.ts` (choose another base port if a run on this machine already uses 4700)
Expected: every step exits 0; `check` 0 errors and 0 warnings; Fallow reports no finding beyond the baseline. A vitest file that times out under load is rerun alone before it counts as a failure.

- [ ] **Step 3: Commit**

```bash
paths=(src/lib/server/services/memory-profile/AGENTS.md)
git add "${paths[@]}"
git commit -m "Record how native Memory recall shares its budget" -m "The next change to recall should start from the lanes, the shares, the whole-line budget and the rule that recall writes nothing, not rediscover them from the code." -- "${paths[@]}"
```

---

### Task 7: Acceptance on the local model and at size

**Files:**
- Create: `src/lib/server/services/memory-profile/native-recall-live.fixture.ts`
- Create: `src/lib/server/services/memory-profile/native-recall-live.integration.test.ts`
- Create: `src/lib/server/services/memory-context/native-recall-size.integration.test.ts`
- Create: `docs/plans/hindsight-memory/recall-part-1-acceptance.md`

**The live check** follows `native-live.integration.test.ts`: it runs only when `HINDSIGHT_NATIVE_ACCEPTANCE === "1"`, boots the job engine with `bootEngine`, points the config at the pinned service on `127.0.0.1:18890` (an SSH tunnel to the non-production Hindsight on the box, which reaches Flash-Next through the admission gateway), and erases its synthetic banks at the end.

The fixture builds an account shaped like sales: 400 facts about an invented person and two projects of 100 and 90 facts, each fact a distinct statement, about a third in Hungarian, delivered through the job engine as sources of 10 facts. For every probe message the fixture names its target facts, each by a marker word that appears in exactly one fact. The token budget is half the person's published tokens. Categories, 20 messages each, half in Hungarian:

| Category | Pass |
|---|---|
| A message quoting an entry's exact text | 20 of 20 return that entry |
| A project topic, in a project chat | 17 of 20 return a target entry |
| A personal topic | 17 of 20 |
| Across languages (an English message for a Hungarian fact, and the reverse) | 15 of 20 |
| A short follow-up in a chat titled with the topic | 15 of 20 |
| A message with a date ("on Friday", "last March") | 17 of 20 |
| A 500-character message | 17 of 20 |

Across every recall in the run, no search may time out, and per bank the 95th percentile of `slowestMs` stays under 2,000 ms. Both are read from the `[KNOWLEDGE_MEMORY] Recall` lines.

**The age probe** runs 20 synthetic turns (10 English, 10 Hungarian) through the app's own chat path on the non-production stack, on Flash-Next. In each, the memory section carries a lasting fact last said more than a year ago, which the question needs. It passes when at most 2 replies remark on the fact's age or doubt it. If it fails, stop and report the counts to the owner: changing the section's words is the owner's call and needs another real-model run.

**The size check** runs locally, only when `MEMORY_RECALL_SIZE_CHECK === "1"`, on in-memory SQLite with the fake client: 5,000 published rows in a personal bank and 1,000 in a project bank, every ranking returning all rows, then 20 per-turn recalls. It logs the median and the 95th percentile of the app-side time and passes when the 95th percentile is under 500 ms. Hindsight's own search time at 5,000 entries is not measured in this plan: building a bank that big through the real pipeline takes days on one inference slot, so it is left for the owner to schedule.

- [ ] **Step 1: Write the fixture and both gated tests**

- [ ] **Step 2: Confirm the normal gate skips them**

Run: `npx vitest run src/lib/server/services/memory-profile/native-recall-live.integration.test.ts src/lib/server/services/memory-context/native-recall-size.integration.test.ts`
Expected: both suites skipped.

- [ ] **Step 3: Run the size check on this Mac**

Run: `MEMORY_RECALL_SIZE_CHECK=1 npx vitest run src/lib/server/services/memory-context/native-recall-size.integration.test.ts`
Expected: PASS, the 95th percentile under 500 ms.

- [ ] **Step 4: Commit**

```bash
paths=(src/lib/server/services/memory-profile/native-recall-live.fixture.ts src/lib/server/services/memory-profile/native-recall-live.integration.test.ts src/lib/server/services/memory-context/native-recall-size.integration.test.ts)
git add "${paths[@]}"
git commit -m "Add live and size checks for fair, message-aware recall" -m "Unit tests prove the sharing. Only a run against the pinned Hindsight, with our embedder and reranker on a sales-shaped account, shows whether the person's own words find the right entries in time, and a run at 5,000 rows shows the app's side stays quick." -- "${paths[@]}"
```

- [ ] **Step 5: Build the bank and run the live check and the age probe on the box, overnight, with the owner's go-ahead**

Run: `HINDSIGHT_NATIVE_ACCEPTANCE=1 npx vitest run src/lib/server/services/memory-profile/native-recall-live.integration.test.ts`, with the tunnel and settings `native-live.integration.test.ts` uses; then the age probe.
Expected: every category at or above its bar, no timeouts, the per-bank 95th percentile under 2,000 ms, and the age probe passing.

- [ ] **Step 6: Record the results** in `recall-part-1-acceptance.md`: the date, the commit, pass or fail per category with its count, the timeouts, the latency median and 95th percentile per bank, the age probe's count and the size check's numbers. Counts and timings only, no entry text. Commit it with `git commit ... -- docs/plans/hindsight-memory/recall-part-1-acceptance.md`.

After merge and deploy, both on the owner's word: run sales' post-cutover recall check on the box (`rollout-recall.mts`) and add its pass or fail to the same document.
