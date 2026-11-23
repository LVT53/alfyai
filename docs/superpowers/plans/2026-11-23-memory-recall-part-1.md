# Memory redesign, part 1: fair, message-aware recall — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every chat's memory recall carries the person's basics plus what their message is about, a project chat reserves half of it for the project's own entries, and each recalled row tells the model how long ago it was last mentioned.

**Architecture:** `recallMemory` (`src/lib/server/services/memory-context/native.ts`) keeps its per-bank verification of Hindsight rankings exactly as it is. It runs one Hindsight search per query per bank (the message; on the per-turn path also a fixed core query), turns each verified ranking into a candidate list, and hands the lists to a pure allocator (`allocateRecall`) that fills capped lanes and then spills leftovers. One formatter (`formatRecalledMemory`) writes the rows for both callers, the per-turn section (`chat-turn/context-selection.ts`) and the `memory_context` tool (`memory-context/persona.ts`), with "last mentioned …" ages and the project's entries under their own line. The two shares are runtime settings (`env.ts` → `config-store.ts` → admin registry).

**Tech Stack:** SvelteKit server code in TypeScript, Drizzle on better-sqlite3, Vitest, the Hindsight HTTP client (`memory-profile/hindsight-client.ts`), Biome, Fallow.

**Spec:** `docs/superpowers/specs/2026-11-22-memory-redesign-design.md`, part 1 ("Fair, time-aware recall"), with its Goals, Constraints and "Calls I made" 4 and 6. Parts 2 to 5 get their own plans once this one ships.

## Global Constraints

- Tests use synthetic data only, never a real person's memories or chats.
- Hindsight recall makes no model call (dateparser, the embedder and the BGE reranker; no decision model is configured), so a second search per bank costs no inference slot. This plan adds no model call.
- Project memory never leaves its project; personal memory may accompany any chat.
- Everything written into a model request is ASCII English, with no language name and no reply-language instruction (ruling 79, `src/lib/server/services/chat-turn/AGENTS.md`, invariants I1 and I3).
- A runtime setting goes through `env.ts` (default), `config-store.ts` (override), the admin registry with English and Hungarian words, `.env.example` and `README.md` (root `AGENTS.md`, "If you add a new runtime-configurable setting").
- Defaults: core share 25 percent (spec: "at most a quarter"), project share 50 percent (spec: "half the budget"); both integers from 0 to 100.
- Until labels exist (part 2) nothing is Earlier, and a row shows its age without a kind.
- Recall writes nothing: being recalled changes no stored row.
- Every Hindsight search keeps the 2-second bound of `AbortSignal.timeout(2_000)`; banks are searched one after another, as today.
- An entry with no dated source gets no age; never invent "today" for an undated fact (`memory-profile/AGENTS.md`).
- Run commands from the worktree with Node 22 first on `PATH` (`export PATH=/opt/homebrew/opt/node@22/bin:$PATH`). `npm run check` stays at 0 errors and 0 warnings, `npx biome check src scripts tests` is clean, Fallow reports no new finding, and the build has zero warnings.
- Nothing in this plan is pushed or deployed. Box runs and production steps need the owner's word.

## Review Focus

1. **A message with no words** (a picture or a file sent alone): no message search runs, and the core and the project's general entries still fill the section. Test: Task 5, "keeps the basics when the message has no words".
2. **A very long pasted message** (tens of thousands of characters): the search query is cut to its first 600 and last 400 characters, so the search stays inside its timeout. Test: Task 5, "cuts a long message to its start and end" and "cuts a long message before searching".
3. **One of a bank's two searches failing or timing out:** the search that answered is still used and nothing it did not rank is added; only when every search of a bank fails does the bank fall back to its accepted rows in stored order, today's offline behaviour. Test: Task 5, "uses the search that answered when the other fails".
4. **A project with few or no entries:** its unused share goes to the person's entries, so no budget is wasted. Test: Task 3, "passes an unused project share on"; Task 4, "fills the rest with personal entries when the project has few".
5. **One entry larger than its lane's share:** skipped in that lane, placed by the spill pass if the total budget still holds it, and the total is never exceeded. Test: Task 3, "places an entry too large for its lane in the spill pass" and "never goes over the budget".

## Order and parallel work

Tasks 1, 2 and 3 touch disjoint files and can run side by side. Task 4 needs all three. Task 5 needs Task 4. Task 6 runs the gates once, at the end. Task 7 is the owner-approved run on the box.

---

### Task 1: Show each recalled entry's age

**Files:**
- Create: `src/lib/server/services/memory-context/recall-format.ts`
- Create: `src/lib/server/services/memory-context/recall-format.test.ts`
- Modify: `src/lib/memory-types.ts:81-85` (`AdmittedMemoryEvidence`)
- Modify: `src/lib/server/services/memory-context/native.ts:270-311` (the output loop)
- Modify: `src/lib/server/services/memory-context/native.test.ts`
- Modify: `src/lib/server/services/memory-context/persona.ts:175-177`
- Modify: `src/lib/server/services/chat-turn/context-selection.ts:425`
- Modify: `src/lib/server/services/chat-turn/context-selection.test.ts`
- Modify: `src/lib/server/services/memory-context.persona-v2.test.ts`

**Interfaces:**
- Produces: `AdmittedMemoryEvidence.lastMentionedAt: string | null`, an ISO 8601 instant: the newest `explicitEditAt ?? assertedAt` among the sources of the entry's admitted supporting facts, or `null` when it has none.
- Produces: `formatRecalledMemory(items: readonly AdmittedMemoryEvidence[], now: Date): string` in `recall-format.ts`. The age helper stays private to the module.

Exact row format: each row is `- ${text}`, followed by ` (last mentioned ${age})` when the entry has a usable date. The person's rows come first, in input order. When any project row exists, the line `Remembered for this project:` follows, then the project rows in input order. The age comes from whole days `d = Math.floor((now - lastMentionedAt) / 86_400_000)`, a future instant counting as `d = 0`:

| d | age |
|---|---|
| 0 | `today` |
| 1 | `yesterday` |
| 2 to 13 | `${d} days ago` |
| 14 to 59 | `${Math.floor(d / 7)} weeks ago` |
| 60 to 729 | `${Math.floor(d / 30)} months ago` |
| 730 and more | `${Math.floor(d / 365)} years ago` |

A `null` or unparseable `lastMentionedAt` gives no suffix.

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

it("says how long ago each entry was last mentioned", () => {
	expect(formatRecalledMemory([0, 1, 3, 13, 14, 59, 60, 729, 730].map((d) => item(`d${d}`, daysAgo(d))), now)).toBe(
		[
			"- d0 (last mentioned today)",
			"- d1 (last mentioned yesterday)",
			"- d3 (last mentioned 3 days ago)",
			"- d13 (last mentioned 13 days ago)",
			"- d14 (last mentioned 2 weeks ago)",
			"- d59 (last mentioned 8 weeks ago)",
			"- d60 (last mentioned 2 months ago)",
			"- d729 (last mentioned 24 months ago)",
			"- d730 (last mentioned 2 years ago)",
		].join("\n"),
	);
});
it("gives an undated entry no age and counts a future date as today", () => {
	expect(formatRecalledMemory([item("undated", null), item("bad", "not a date"), item("future", daysAgo(-2))], now)).toBe(
		"- undated\n- bad\n- future (last mentioned today)",
	);
});
it("puts the project's entries after the person's, under their own line", () => {
	expect(
		formatRecalledMemory([item("Project A", null, "project"), item("Likes tea", null), item("Project B", null, "project")], now),
	).toBe("- Likes tea\nRemembered for this project:\n- Project A\n- Project B");
});
it("adds only ASCII words around the entries", () => {
	const out = formatRecalledMemory([item("x", daysAgo(5)), item("y", daysAgo(400), "project")], now);
	expect(/^[\x20-\x7e\n]*$/.test(out)).toBe(true);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/lib/server/services/memory-context/recall-format.test.ts`
Expected: FAIL, the module `./recall-format` does not exist.

- [ ] **Step 3: Implement `formatRecalledMemory` and add `lastMentionedAt: string | null` to `AdmittedMemoryEvidence`**

- [ ] **Step 4: Write the failing recall test** in `native.test.ts`, "reports the newest date among an entry's sources"

Seed one personal bank (`bank "b1"`, scope `personal`) with two accepted source revisions: `s1` with `assertedAt` `2026-10-01T00:00:00Z` acknowledging fact `f1`, and `s2` with `assertedAt` `2026-11-01T00:00:00Z` and `explicitEditAt` `2026-11-10T00:00:00Z` acknowledging fact `f2`. Seed one published row whose `sourceIdsJson` is `["f1","f2"]` and whose `sourceFingerprintsJson` lists both facts. Leave the recall mock offline (its default). Assert `result[0].lastMentionedAt === "2026-11-10T00:00:00.000Z"`. Give the existing `seed()` helper an optional `assertedAt` instead of copying it.

- [ ] **Step 5: Run it to see it fail**

Run: `npx vitest run src/lib/server/services/memory-context/native.test.ts`
Expected: FAIL on the new test (`lastMentionedAt` is undefined).

- [ ] **Step 6: Fill `lastMentionedAt` in `recallMemory`'s output loop**

While the loop builds `sources` from the row's admitted facts, keep the largest `(fact.source.explicitEditAt ?? fact.source.assertedAt).getTime()` and push it as an ISO string, or `null` when the row has no admitted fact.

- [ ] **Step 7: Use the formatter in both callers**

`context-selection.ts:425` becomes `const content = formatRecalledMemory(recalled, new Date());`. In `persona.ts:175-177` the native branch's `content` becomes `formatRecalledMemory(recalled, new Date())` when anything was recalled, else `null`.

- [ ] **Step 8: Write the failing caller tests**

In `context-selection.test.ts`, add `usesNativeMemory` and `recallMemory` to the hoisted `mocks`; mock `"../memory-profile/chat-delivery"` with `importOriginal` spread and `usesNativeMemory: mocks.usesNativeMemory`; mock `"../memory-context/native"` as `() => ({ recallMemory: mocks.recallMemory })` (it exports nothing else). `resetConstructedContextMocks()` sets `usesNativeMemory` to return `false` and `recallMemory` to resolve `[]`, so every existing test keeps the legacy path. New test, "shows how long ago each remembered entry was mentioned": `usesNativeMemory` returns `true`, `isMemoryActiveForConversation` resolves `true`, `recallMemory` resolves one personal entry `"Prefers green tea"` with `lastMentionedAt` 3 days and 1 hour before `Date.now()`; `buildConstructedContext({ userId: "user-1", conversationId: "conversation-1", message: "What should I drink this afternoon?", modelId: "local-model", contextLimits: { maxModelContext: 16_000, compactionUiThreshold: 12_000, targetConstructedContext: 8_000 } })`; assert `inputValue` contains `"## Remembered information"` and `"- Prefers green tea (last mentioned 3 days ago)"`.

In `memory-context.persona-v2.test.ts`, mock `"./memory-context/native"` as `() => ({ recallMemory: mocks.recallMemory })` (a hoisted mock); new test, "the native tool says how long ago each entry was mentioned": `usesNativeMemory` returns `true` for this test, `recallMemory` resolves one personal entry `"Prefers green tea"` with `lastMentionedAt` 36 hours before `Date.now()`; assert `result.content === "- Prefers green tea (last mentioned yesterday)"`.

- [ ] **Step 9: Run the tests**

Run: `npx vitest run src/lib/server/services/memory-context/recall-format.test.ts src/lib/server/services/memory-context/native.test.ts src/lib/server/services/chat-turn/context-selection.test.ts src/lib/server/services/memory-context.persona-v2.test.ts && npm run check`
Expected: all PASS; check reports 0 errors and 0 warnings.

- [ ] **Step 10: Commit**

```bash
git add src/lib/memory-types.ts src/lib/server/services/memory-context/recall-format.ts src/lib/server/services/memory-context/recall-format.test.ts src/lib/server/services/memory-context/native.ts src/lib/server/services/memory-context/native.test.ts src/lib/server/services/memory-context/persona.ts src/lib/server/services/chat-turn/context-selection.ts src/lib/server/services/chat-turn/context-selection.test.ts src/lib/server/services/memory-context.persona-v2.test.ts
git commit -m "Show the model how long ago each remembered entry was mentioned" -m "Recalled rows reached the model as bare text, so a toothache from March read as current as a sister. Each row now says when it was last mentioned, from its newest source date, and a project's entries sit under their own line. Both the per-turn section and the memory_context tool share one formatter."
```

---

### Task 2: Two recall shares as runtime settings

**Files:**
- Modify: `src/lib/server/env.ts` (the env config type near line 86, the parse near line 741)
- Modify: `src/lib/server/config-store.ts` (the admin key list near line 136, `RuntimeConfig` near line 256, the defaults near line 420, the apply map near line 1111, the string projection near line 1925, and a new getter)
- Modify: `src/lib/config/admin-config-registry.ts` (the memory group, near line 391)
- Modify: `src/lib/i18n/settings.ts` (English near line 1714, Hungarian near line 3936)
- Modify: `.env.example` (after `MEMORY_MAINTENANCE_INTERVAL_MINUTES`, line 141)
- Modify: `README.md` (the Hindsight paragraph ending at line 269)
- Test: `src/lib/server/config-store.memory-v2.test.ts`

**Interfaces:**
- Produces: `getMemoryRecallShares(): { corePercent: number; projectPercent: number }`, exported from `src/lib/server/config-store.ts`, reading `getConfig().memoryRecallCorePercent` and `getConfig().memoryRecallProjectPercent`.
- Keys: `MEMORY_RECALL_CORE_PERCENT` (default 25) and `MEMORY_RECALL_PROJECT_PERCENT` (default 50), integers from 0 to 100. A value outside that range or not an integer is ignored: the environment falls back to the default, an admin override leaves the current value.

- [ ] **Step 1: Write the failing tests** in `config-store.memory-v2.test.ts` (add both keys to the `afterEach` cleanup list)

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

Add, in the style `config-store.promoted-keys.test.ts` uses for applying admin overrides, a test that an override of `MEMORY_RECALL_PROJECT_PERCENT` = `"60"` gives `projectPercent: 60`, and that `"abc"` and `"101"` leave it at 50.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/server/config-store.memory-v2.test.ts`
Expected: FAIL, `getMemoryRecallShares` is not exported.

- [ ] **Step 3: Implement the two keys along the existing memory pattern** (`MEMORY_JUDGE_IDLE_MINUTES` is the model to follow in each file)

Registry entries: `{ key: "MEMORY_RECALL_CORE_PERCENT", group: "memory", control: int(0, 100), effect: "live" }` and the same for `MEMORY_RECALL_PROJECT_PERCENT`. There is no percent unit, so the labels carry "(%)".

Exact words:

| Key | English label | English meaning | Hungarian label | Hungarian meaning |
|---|---|---|---|---|
| `MEMORY_RECALL_CORE_PERCENT` | Basics share of recall (%) | Percent of each chat's memory space kept for the person's basics. | Alapadatok aránya (%) | A beszélgetésenkénti memóriakeret hány százaléka jut a személy alapadataira. |
| `MEMORY_RECALL_PROJECT_PERCENT` | Project share of recall (%) | In a project chat, percent of the memory space kept for that project's own memories. | Projekt aránya (%) | Projektbeszélgetésben a memóriakeret hány százaléka jut a projekt saját emlékeire. |

`.env.example`, after `MEMORY_MAINTENANCE_INTERVAL_MINUTES=0`:

```
# Native Memory recall: percent of each chat's memory space kept for the person's basics (0-100)
MEMORY_RECALL_CORE_PERCENT=25
# Native Memory recall: in a project chat, percent kept for the project's own memories (0-100)
MEMORY_RECALL_PROJECT_PERCENT=50
```

`README.md`, appended to the paragraph that ends at line 269: "Native recall shares each chat's memory space: `MEMORY_RECALL_CORE_PERCENT` (default 25) is kept for the person's basics and, in a project chat, `MEMORY_RECALL_PROJECT_PERCENT` (default 50) for that project's own memories; what the message is about fills the rest. Both are admin-overridable."

- [ ] **Step 4: Run the tests and the registry checks**

Run: `npx vitest run src/lib/server/config-store.memory-v2.test.ts src/lib/config/admin-config-registry.test.ts src/lib/server/config-store.promoted-keys.test.ts "src/routes/(app)/settings/_components/system/AdvancedPage.unwired.test.ts" && npm run check`
Expected: all PASS; check reports 0 errors and 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/env.ts src/lib/server/config-store.ts src/lib/config/admin-config-registry.ts src/lib/i18n/settings.ts .env.example README.md src/lib/server/config-store.memory-v2.test.ts
git commit -m "Add admin-tunable shares for native Memory recall" -m "Recall will reserve part of each chat's memory space for the person's basics and, in a project chat, for the project's own memories. The defaults follow the agreed design (a quarter and a half); the admin can tune them without a deploy."
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
export interface RecallLane { candidates: readonly RecallCandidate[]; capTokens: number }
export function allocateRecall(lanes: readonly RecallLane[], budgetTokens: number): string[];
```

The algorithm, because the tests alone leave the spill order open:

1. First pass, lanes in array order: take each candidate whose key is not taken yet, when the lane's taken tokens plus its tokens stay within `capTokens` and the total stays within `budgetTokens`. A candidate that does not fit is skipped and the next one is tried.
2. Spill pass, lanes in the same order: take each candidate not taken yet that still fits the total, ignoring the caps.
3. Return the taken keys in the order taken.

Callers order the lanes so that the spill order is right: the project lane first, then the core lane, then the message lane.

- [ ] **Step 1: Write the failing tests**

```ts
const run = (prefix: string, n: number, tokens = 10) =>
	Array.from({ length: n }, (_, i) => ({ key: `${prefix}${i}`, tokens }));

it("reserves a project's share even when the person's entries alone would fill the budget", () => {
	const lanes = [
		{ candidates: run("j", 10), capTokens: 50 },
		{ candidates: run("c", 10), capTokens: 25 },
		{ candidates: run("m", 10), capTokens: 100 },
	];
	expect(allocateRecall(lanes, 100)).toEqual(["j0", "j1", "j2", "j3", "j4", "c0", "c1", "m0", "m1", "m2"]);
});
it("passes an unused project share on", () => {
	const lanes = [
		{ candidates: run("j", 1), capTokens: 50 },
		{ candidates: run("c", 10), capTokens: 25 },
		{ candidates: run("m", 10), capTokens: 100 },
	];
	expect(allocateRecall(lanes, 100)).toEqual(["j0", "c0", "c1", "m0", "m1", "m2", "m3", "m4", "m5", "m6"]);
});
it("takes an entry that two searches found once", () => {
	const lanes = [
		{ candidates: [{ key: "a", tokens: 10 }, { key: "b", tokens: 10 }], capTokens: 100 },
		{ candidates: [{ key: "b", tokens: 10 }, { key: "c", tokens: 10 }], capTokens: 100 },
	];
	expect(allocateRecall(lanes, 100)).toEqual(["a", "b", "c"]);
});
it("places an entry too large for its lane in the spill pass", () => {
	const lanes = [
		{ candidates: [{ key: "big", tokens: 60 }, { key: "j1", tokens: 10 }], capTokens: 50 },
		{ candidates: [], capTokens: 25 },
		{ candidates: [{ key: "m0", tokens: 10 }], capTokens: 100 },
	];
	expect(allocateRecall(lanes, 100)).toEqual(["j1", "m0", "big"]);
});
it("never goes over the budget", () => {
	const lanes = [
		{ candidates: run("j", 7, 13), capTokens: 60 },
		{ candidates: run("c", 7, 17), capTokens: 30 },
		{ candidates: run("m", 7, 23), capTokens: 100 },
	];
	const tokens = new Map(lanes.flatMap((lane) => lane.candidates.map((c) => [c.key, c.tokens] as const)));
	const total = allocateRecall(lanes, 100).reduce((sum, key) => sum + (tokens.get(key) ?? 0), 0);
	expect(total).toBeLessThanOrEqual(100);
});
it("takes nothing from a zero budget", () => {
	expect(allocateRecall([{ candidates: run("m", 3), capTokens: 100 }], 0)).toEqual([]);
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
git add src/lib/server/services/memory-context/recall-allocation.ts src/lib/server/services/memory-context/recall-allocation.test.ts
git commit -m "Add a lane allocator for sharing the memory recall budget" -m "Recall filled one budget bank by bank, personal first, so a large personal bank left nothing for the project in a project chat. The allocator gives each lane its own cap, never repeats an entry two searches found, and spills what is left so no share goes unused."
```

---

### Task 4: A fair split in `recallMemory`

**Files:**
- Modify: `src/lib/server/services/memory-context/native.ts:155-314` (the transaction's budget fill)
- Modify: `src/lib/server/services/memory-context/native.test.ts`

**Interfaces:**
- Consumes: `allocateRecall` and `RecallLane` (Task 3); `getMemoryRecallShares()` (Task 2); `lastMentionedAt` (Task 1).
- Produces: `recallMemory(userId, { conversationId, query, tokenBudget })`, its signature unchanged in this task. The rows it returns are now chosen by the allocator, the person's entries listed first and the project's after, each in the order chosen.

In the transaction, replace the bank-by-bank fill with three steps:

1. For each readable bank, its candidate rows, in exactly the order the old code would have offered them (by the verified ranking when there is one, otherwise every accepted row in stored order), leaving out a row whose `sourceIdsJson` is not an array. Key `${bank.id}:${row.nativeId}`, tokens `estimateTokenCount(row.text)`.
2. Lanes, with `B = Math.max(0, Math.floor(tokenBudget))`: in a project chat, the project bank's rows with cap `Math.floor((B * projectPercent) / 100)`; then the personal bank's rows with cap `B`. Call `allocateRecall(lanes, B)`.
3. Build each chosen entry as today (sources, ref, text, `lastMentionedAt`), the personal bank's entries first.

The verification of each ranking (`order`, bridges, migration families, the evidence snapshot) does not change.

- [ ] **Step 1: Write the failing tests**

Test support in `native.test.ts`:
- The client mock passes the bank to the shared mock: `recall: (query: string, budget: number) => recall(query, budget, signal, bankId)`. Existing tests ignore the fourth argument.
- Mock `"$lib/server/config-store"` with `importOriginal` spread and `getMemoryRecallShares: () => shares`, where `shares` is reset to `{ corePercent: 25, projectPercent: 50 }` in `beforeEach`.
- `seedBankRows(bankId: string, scopeKey: string, texts: string[])`: one bank, then per text `i` an accepted source revision `s-${bankId}-${i}` acknowledging fact `f-${bankId}-${i}`, and a published row with native id `n-${bankId}-${i}` supported by that fact (the same fields `seed()` writes).
- `ranked(bankId: string, texts: string[], indices: number[])`: the observations Hindsight would return, `{ id: \`n-${bankId}-${i}\`, text: texts[i], fact_type: "observation", source_memory_ids: [\`f-${bankId}-${i}\`] }`.

Tests, with `personal = 40` texts `Personal fact ${String(i).padStart(2, "0")}` in bank `bp` (scope `personal`) and project texts `Project fact ${String(i).padStart(2, "0")}` in bank `bj` (scope `project:p`); `tp` and `tj` are `estimateTokenCount` of one personal and one project text; the recall mock returns all of a bank's rows in order:

1. "gives a project chat's own entries half the budget when the person's entries alone would fill it": 20 project texts, chat `c`. First assert the precondition `tp === tj` (both texts estimate to 4 tokens, so no spill can blur the counts), then with `B = 20 * tp`: exactly 10 project entries, exactly 10 personal entries, the personal entries first, and the total tokens at most `B`.
2. "fills the rest with personal entries when the project has few": 2 project texts, `B = 20 * tp`, chat `c`. Exactly 2 project entries, and the personal entries fill `B` to within one row (`B - personalTokens < tp + 2 * tj`).
3. "keeps a personal chat's recall as it was": chat `personal`, `B = 10 * tp`. The entries are the first `Math.floor(B / tp)` personal texts in ranking order.
4. "writes nothing while recalling": read `(sqlite.prepare("select total_changes() as n").get() as { n: number }).n` before and after a recall in chat `c`; the two are equal.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/server/services/memory-context/native.test.ts`
Expected: FAIL on tests 1 and 2 (no project entries are returned); 3 and 4 may already pass.

- [ ] **Step 3: Implement the three steps above in `recallMemory`**

- [ ] **Step 4: Run the recall tests and every test that calls `recallMemory`**

Run: `npx vitest run src/lib/server/services/memory-context/native.test.ts src/lib/server/services/memory-profile/curation.integration.test.ts src/lib/server/services/memory-profile/migration.integration.test.ts && npm run check`
Expected: all PASS. A failure in an integration test is a change in behaviour to understand and report, not an expectation to edit.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/services/memory-context/native.ts src/lib/server/services/memory-context/native.test.ts
git commit -m "Give a project chat's own memories a reserved half of recall" -m "Sales has 386 personal entries and 98 and 91 project entries; recall filled the budget with personal rows and returned none of the project's, even for a project entry's exact text. The project bank now gets its configured share first, unused shares pass on, and personal chats are unchanged."
```

---

### Task 5: Search with the person's message and keep a core of basics

**Files:**
- Create: `src/lib/server/services/memory-context/recall-query.ts`
- Create: `src/lib/server/services/memory-context/recall-query.test.ts`
- Modify: `src/lib/server/services/memory-context/native.ts`
- Modify: `src/lib/server/services/memory-context/native.test.ts`
- Modify: `src/lib/server/services/chat-turn/context-selection.ts` (`buildActiveMemoryProfilePromptSection`, lines 396-439, and its two calls, lines 1649 and 2360)
- Modify: `src/lib/server/services/chat-turn/context-selection.test.ts`

**Interfaces:**
- Produces, in `recall-query.ts`: `CORE_MEMORY_QUERY = "Relevant user preferences, constraints and current context"` (moved from `context-selection.ts:421`), and `messageRecallQuery(message: string): string | null`.
- Produces: `recallMemory(userId, { conversationId, query, tokenBudget, core?: boolean })`. `query` is what the person wrote (the per-turn section) or the model's query (the tool), and passes through `messageRecallQuery`. `core: true` also searches each bank with `CORE_MEMORY_QUERY` and adds the core lane.
- Consumes: `getMemoryRecallShares()` (Task 2), `allocateRecall` (Task 3), the candidate rows and output order of Task 4.

`messageRecallQuery`: fold whitespace with `normalizeWhitespace` from `$lib/server/utils/text`; an empty result is `null`; up to 1,000 characters it is unchanged; a longer one becomes its first 600 characters, then `" ... "`, then its last 400 characters, counting characters with `Array.from` so a character is never split.

Searches in `recallMemory`:
- A bank's searches are the message query (when not `null`) and, with `core`, `CORE_MEMORY_QUERY`. They run concurrently, each through its own `nativeMemoryClient(bank.id, account.tenantId, AbortSignal.timeout(2_000))` with the existing before-dispatch check; the `isStillActive` check before each bank stays, and banks stay sequential.
- A bank whose every search failed gives its accepted rows in stored order to each of its lanes, as today. A bank with at least one answered search gives each lane only the verified rows of that lane's own search, which is an empty list when that search failed.
- The evidence snapshot (`client.list()`) is taken at most once per bank, when any of its rankings meets the existing condition.
- Lanes with `core: true`: project (the project bank's message rows, then its core rows; cap `Math.floor((B * projectPercent) / 100)`); core (the personal bank's core rows; cap `Math.floor((B * corePercent) / 100)`); message (the personal bank's message rows; cap `B`). Without `core`: project (the project bank's message rows; same cap) and message (the personal bank's message rows; cap `B`).
- The output order stays as in Task 4.

In `context-selection.ts`, `buildActiveMemoryProfilePromptSection` takes `message: string`, both calls pass `message: params.message`, and the native branch calls `recallMemory(params.userId, { conversationId: params.conversationId, query: params.message, tokenBudget: baselineMemoryProfileBudget.totalBudget, core: true })`.

- [ ] **Step 1: Write the failing query tests** in `recall-query.test.ts`

```ts
it("keeps a message's words as its query", () => {
	expect(messageRecallQuery("  What should I\n\ncook tonight? ")).toBe("What should I cook tonight?");
});
it("searches nothing for a message with no words", () => {
	expect(messageRecallQuery("")).toBeNull();
	expect(messageRecallQuery(" \n\t ")).toBeNull();
});
it("keeps a message of 1,000 characters whole", () => {
	const message = "a".repeat(1000);
	expect(messageRecallQuery(message)).toBe(message);
});
it("cuts a long message to its start and end", () => {
	expect(messageRecallQuery(`${"s".repeat(600)}${"x".repeat(5000)}${"e".repeat(400)}`)).toBe(
		`${"s".repeat(600)} ... ${"e".repeat(400)}`,
	);
});
it("cuts by characters, never inside one", () => {
	expect(messageRecallQuery("😀".repeat(1500))).toBe(`${"😀".repeat(600)} ... ${"😀".repeat(400)}`);
});
```

- [ ] **Step 2: Write the failing recall tests** in `native.test.ts` (fixtures from Task 4; chat `c` is in project `p`)

1. "searches with the message and the core on the per-turn path": `core: true`, `query: "What should I cook tonight?"`. `recall` is called with `"What should I cook tonight?"` and with `CORE_MEMORY_QUERY` for both `bp` and `bj`; with the mock returning personal indices `[0, 1]` for the core query and `[2, 3]` for the message, the personal entries are `Personal fact 00`, `01`, `02`, `03` in that order.
2. "keeps the basics when the message has no words": `core: true`, `query: "  "`. `recall` is called only with `CORE_MEMORY_QUERY`, and the core-ranked rows come back.
3. "uses the search that answered when the other fails": chat `personal`, `core: true`; the message search rejects and the core search returns personal indices `[3, 1]`. The result is exactly `Personal fact 03` and `Personal fact 01`.
4. "searches once with the query on the tool path": no `core`; one `recall` call per bank, with the query.
5. "cuts a long message before searching": a 5,000-character `query`; the first argument `recall` receives has at most 1,005 characters (`Array.from(arg).length`).
6. "brings the project entry whose text the message quotes": tool path, chat `c`, 20 project rows; when the query is `"Project fact 07"` the mock ranks `bj` index 7 first. `Project fact 07` is in the result.

- [ ] **Step 3: Write the failing caller tests** in `context-selection.test.ts`

7. "searches memory with the person's message and the core of basics": `usesNativeMemory` returns `true`, message `"What should I cook tonight?"`; `mocks.recallMemory` was called with `expect.objectContaining({ query: "What should I cook tonight?", core: true })`.
8. The same with the short message `"Thanks, that helps."`, which takes the shallow tier.

- [ ] **Step 4: Run them to see them fail**

Run: `npx vitest run src/lib/server/services/memory-context/recall-query.test.ts src/lib/server/services/memory-context/native.test.ts src/lib/server/services/chat-turn/context-selection.test.ts`
Expected: FAIL (no `recall-query` module, no `core` option, the per-turn section still sends the fixed sentence).

- [ ] **Step 5: Implement `messageRecallQuery`, the searches and the lanes in `recallMemory`, and the caller change**

- [ ] **Step 6: Run the tests, the ruling-79 checks and the type check**

Run: `npx vitest run src/lib/server/services/memory-context src/lib/server/services/chat-turn/context-selection.test.ts src/lib/server/services/memory-context.persona-v2.test.ts tests/integration/reply-language.test.ts tests/integration/english-request-purity.test.ts && npm run check`
Expected: all PASS; check reports 0 errors and 0 warnings.

- [ ] **Step 7: Commit**

```bash
git add src/lib/server/services/memory-context/recall-query.ts src/lib/server/services/memory-context/recall-query.test.ts src/lib/server/services/memory-context/native.ts src/lib/server/services/memory-context/native.test.ts src/lib/server/services/chat-turn/context-selection.ts src/lib/server/services/chat-turn/context-selection.test.ts
git commit -m "Search memory with what the person wrote, beside a core of basics" -m "Every turn searched memory with one fixed sentence, so what the person was talking about never chose what Alfy remembered. Each chat now keeps a core of the person's basics (the old fixed search, at most a quarter) and fills the rest from the person's own message, cut to its start and end when long. Recall makes no model call, so this costs no inference slot."
```

---

### Task 6: Record the recall rules and run the gates

**Files:**
- Modify: `src/lib/server/services/memory-profile/AGENTS.md` (a new paragraph after the first paragraph of "Native replacement boundary")

- [ ] **Step 1: Add this paragraph**

> Recall (`memory-context/native.ts`, `recallMemory`) only reads, and has two callers. Every turn's section (`chat-turn/context-selection.ts`) searches each eligible bank twice: with the person's message (`messageRecallQuery`: whitespace folded, a long message cut to its first 600 and last 400 characters) and with the fixed core query (`CORE_MEMORY_QUERY`). The `memory_context` tool searches once, with the model's query. `allocateRecall` (`memory-context/recall-allocation.ts`) shares the budget in lanes: a project chat's own entries up to `MEMORY_RECALL_PROJECT_PERCENT` (default 50), the person's basics up to `MEMORY_RECALL_CORE_PERCENT` (default 25, the per-turn section only), the entries matching the person's message in the rest, then what is left over. A bank whose searches all fail gives its accepted rows in stored order. Rows reach the model through `formatRecalledMemory` (`memory-context/recall-format.ts`): the person's entries, then the project's under their own line, each with how long ago it was last mentioned (its newest source date). Recall writes nothing: being recalled never keeps an entry current.

- [ ] **Step 2: Run the whole gate once**

Run: `scripts/gates.sh agent "$TMPDIR/alfyai-gates-recall" --port 4700 tests/e2e/chat.spec.ts tests/e2e/streaming.spec.ts tests/e2e/conversation.spec.ts` (choose another base port if a run on this machine already uses 4700)
Expected: every step exits 0; `check` 0 errors and 0 warnings; Fallow reports no finding beyond the baseline. A vitest file that times out under load is rerun alone before it counts as a failure.

- [ ] **Step 3: Commit**

```bash
git add src/lib/server/services/memory-profile/AGENTS.md
git commit -m "Record how native Memory recall shares its budget" -m "The next change to recall should start from the lanes, the shares and the rule that recall writes nothing, not rediscover them from the code."
```

---

### Task 7: Acceptance on the local model (an owner-approved run on the box)

**Files:**
- Create: `src/lib/server/services/memory-profile/native-recall-live.integration.test.ts`
- Create: `docs/plans/hindsight-memory/recall-part-1-acceptance.md`

The test follows `native-live.integration.test.ts`: it runs only when `HINDSIGHT_NATIVE_ACCEPTANCE === "1"`, boots the job engine with `bootEngine`, points the config at the pinned service on `127.0.0.1:18890` (an SSH tunnel to the non-production Hindsight on the box, which reaches Flash-Next through the admission gateway), and erases its synthetic banks at the end.

It delivers synthetic sources through the job engine: for an invented person, 40 facts in 8 sources, about a third in Hungarian (one names a cat, Mák); for an invented project, 20 facts in 4 sources. It waits until they are published, sets the token budget to half the person's published tokens, and checks:

1. "a project chat gets its project's entries": for 5 messages about the project (3 English, 2 Hungarian), project entries are at least 40% of the tokens returned.
2. "a message quoting an entry finds it": a message equal to one project entry's text returns that entry.
3. "a short message keeps the basics": `"thanks"` in a personal chat returns at least 5 entries.
4. "a Hungarian message finds its entry": a Hungarian message about the cat returns the entry that names Mák.
5. "recall stays quick": 20 per-turn recalls in the project chat take under 4,000 ms each at the 95th percentile (two banks, two seconds each); the test logs the median and the 95th percentile.

- [ ] **Step 1: Write the acceptance test**

- [ ] **Step 2: Confirm the normal gate skips it**

Run: `npx vitest run src/lib/server/services/memory-profile/native-recall-live.integration.test.ts`
Expected: the suite is skipped (no `HINDSIGHT_NATIVE_ACCEPTANCE`).

- [ ] **Step 3: Commit**

```bash
git add src/lib/server/services/memory-profile/native-recall-live.integration.test.ts
git commit -m "Add a live acceptance check for fair, message-aware recall" -m "Unit tests prove the sharing; only a run against the pinned Hindsight and our own embedder and reranker shows that the person's own words, English or Hungarian, find the right entries in time."
```

- [ ] **Step 4: Run it on the box, overnight, with the owner's go-ahead**

Run: `HINDSIGHT_NATIVE_ACCEPTANCE=1 npx vitest run src/lib/server/services/memory-profile/native-recall-live.integration.test.ts`, with the tunnel and settings `native-live.integration.test.ts` uses.
Expected: all five checks PASS.

- [ ] **Step 5: Record the result** in `recall-part-1-acceptance.md`: the date, the commit, pass or fail per check, and the latency median and 95th percentile. Counts and timings only, no entry text. Commit it.

After merge and deploy, both on the owner's word: run sales' post-cutover recall check on the box (`rollout-recall.mts`) and add its pass or fail to the same document.
