# RV-5a — independent review of Slice 5a (the three tools, the catalogue, the eval harness core)

**Scope:** `git diff 2bf644aa..cb9a0775` — `1b24cf93` (the catalogue and the static paragraph), `05b0f80c`
(`create_artifact`/`read_artifact`/`edit_artifact`), `623473b9` (the eval harness core), `cb9a0775` (the retry-wiring
fix). Reviewed against `AGENTS.md`, `slice-5.md`, `decisions.md` rulings 23/40/41/43/44/49, `working-plan.md` §6/§11,
ADR-0055 and ADR-0066. Ruling 50's seven confirmed-deliberate choices (three per-tool registries, `unsupported_kind`
as the seed refusal reason, an edit-on-unknown-id answering with candidates, `read_artifact` defaulting to `"full"`,
the harness circuit breaker counting a case's outcome after its one retry, bare `tsx` in npm scripts, and the harness
core being built from the ADR text) were reviewed for correctness, not re-litigated.

**Method:** every defect below was reproduced with a failing test first (the red run is quoted), fixed with the
smallest change inside 5a's own files, and re-verified. Nothing outside 5a's file set was touched. One live smoke
call was made against the real vLLM endpoint through a single-command SSH tunnel, per the task's own recipe.

## Verdict: **merge with these fixes**

The three tools, the catalogue and the harness core are well-built and mostly match the spec precisely — the
byte-identical system-prompt guarantee holds structurally (the catalogue param does not exist on
`buildOutboundSystemPrompt`'s signature at all, so it cannot leak there even by a future mistake), the token-budget
raise's measured numbers check out exactly, model-facing schemas carry no scope fields, and the tool-catalogue
snapshots are purely additive in both languages. But two of the four defects found are containment/trust breaks
in exactly the areas this wave was asked to hunt (cross-conversation artifact leakage, and a way to defeat the
eval harness's own gate), so this should not land as-is. All four are fixed on this branch with red tests recorded
below; holding the branch at its current HEAD (not at `cb9a0775`) is what I'd merge.

## Findings

| # | Severity | Where | What breaks, for whom | Test | Commit |
|---|---|---|---|---|---|
| 1 | **High** | `normal-chat-tools/artifact-tools/{read,edit}.ts` | `getArtifact` (`artifacts/record.ts`'s `readScopedArtifactRow`) is scoped to "any non-incognito conversation this user can reach" — correct for its other caller, `GET /api/artifacts/[id]`, which opens an artifact by id from anywhere. `read_artifact`/`edit_artifact` inherited that width unchanged: a model in conversation A could read or edit an artifact made in a different, ordinary (non-incognito) conversation B of the *same* user, by naming its id — an id A's catalogue never listed and the model was never handed. `read_artifact` returned `success:true` with B's real body; `edit_artifact` revealed the artifact's existence and kind via an `unsupported_kind` refusal instead of the "not found" + candidates shape both tools promise for an unknown id. | `tests/cross-cutting/incognito-artifact-containment.test.ts` — two new cases under "the model tool layer … across two normal conversations of the same user" | `a2e2d8c4` |
| 2 | **Medium** | `artifacts/catalogue.ts`'s `clampTitle` | An artifact `title` is user- *and* model-controlled text with no shape restriction beyond length (`createArtifactInputSchema` only caps at 200 chars), rendered verbatim into the "## In this chat" turn-guidance block. A title containing a raw newline could escape its own bullet line and render as a second `##` heading (or any other line-leading token) inside the block — a prompt-injection-adjacent structural break the spec explicitly calls out ("normalise to one line"). | `src/lib/server/services/artifacts/catalogue.test.ts` — `"normalizes a title with newlines, a fake heading, backticks and quotes to one line"`; also added a regression-lock for the (already-correct) surrogate-pair clipping | `c6dfe4bb` |
| 3 | **Low-Medium** | `artifacts/catalogue.ts`'s `resolveArtifactCatalogueBlock` | The Failure Modes table is explicit: a failed catalogue lookup must fail open **and** "the reason goes to the existing `[NORMAL_CHAT_CONTEXT]` log prefix … — no new tag." The shipped `catch { return null; }` logged nothing, so a catalogue that silently broke in production (bad migration, closed connection, a scope regression) would leave no trace anywhere. | `catalogue.test.ts` — `"logs compactly through the existing [NORMAL_CHAT_CONTEXT] prefix when the lookup fails"` | `e4ffe2d6` |
| 4 | **Medium-High (harness trust)** | `scripts/eval-artifact-contracts/run.ts`'s `runSuite` | `--only` was applied to the suite's full case list *before* it was split into known-bad/regular, so naming only a regular fixture id (the ordinary "iterate on one fixture" workflow the harness's own README recommends) silently emptied the known-bad set. `runSuite` then took the "this suite declares no known-bad fixtures" branch — a log warning, not a failure — so a suite whose scorer had regressed enough to let a known-bad fixture through would still report `knownBadFailedAsExpected: true` and go on to trust the regular results. `--limit` was already correctly scoped to the regular set only; `--only` was not. | `scripts/eval-artifact-contracts/run.test.ts` — `"still runs every known-bad fixture, and can still fail the gate, when --only names none of them"` | `5a8778c6` (+ doc correction `6f2b9dd3`) |

Also added (no defect — closing an explicitly-requested coverage question): `tests/cross-cutting/incognito-artifact-containment.test.ts` gains two cases proving `listArtifactCatalogueEntries`/`resolveArtifactCatalogueBlock` inherit incognito containment correctly in both directions. slice-5.md's file table says this suite gains "the catalogue read"; 5a reported it unchanged. I confirmed the omission is safe (the catalogue is a thin passthrough over the already-covered `listArtifactsForConversation`, unlike finding #1's `getArtifact` path) but it was an inference from reading the source, not something the suite proved — now it does. Commit `81699f93`. One follow-up style commit (`8aba3d9a`) fixes two dead `biome-ignore` comments and a formatter-preferred line wrap introduced by this review's own new tests, caught by the full gate run.

## Hunt list — what checked out clean

- **Prompt-prefix byte stability (G1/ADR-0055).** `buildOutboundSystemPrompt`'s signature has no `artifactCatalogueBlock` field at all and its one call site (`normal-chat-context.ts:1954`) never threads one in — the catalogue cannot reach the system prompt by construction, not just by convention. `artifactCatalogueBlock` only exists on `buildTurnGuidance`'s params, rendered into the post-user-message sections array. The six pre-existing byte-identical regression cases (`normal-chat-context.test.ts:645-1027`) stayed green throughout, plus 4 new cases proving the catalogue rides turn guidance and changes only with the conversation's artifacts, never the message. Both `tool-catalogue.{en,hu}.snapshot.txt` diffs are pure insertions (94/94 lines) of exactly the three new tools, positioned after `read_generated_file` as the spec names, with every other tool's text and the tool order byte-for-byte unchanged.
- **No scope fields in model-facing schemas.** `createArtifactModelInputSchema`/`editArtifactModelInputSchema`/`readArtifactInputSchema` carry only `artifactType`/`title`/`body`, `artifactId`/`patches`/`ops`/`summary`, and `artifactId`/`detail` respectively — confirmed against the actual rendered JSON schema in the snapshot files, not just the Zod source. `userId`/`conversationId`/`turnId` come from `CreateNormalChatToolsContext` (the server-owned closure), never from parsed model input; none of the three schemas use `.passthrough()`, so even a smuggled extra key would be silently stripped by Zod's default `.safeParse` behaviour.
- **EN/HU parity and the token budget.** Read both descriptions line-by-line for all three tools: the six required guidance points (when to make one, the four-type choice, one-per-request, never invent an id, one worked example, the retry rule) appear in the same order in both languages, and the App/Slides/Canvas/File-specific clauses match. Re-measured the catalogue independently (temporarily instrumented the existing test, reverted after): **4,804 en / 7,823 hu**, exactly matching the commit's claimed numbers, against ceilings raised to 4,830/7,850 — margins of 26/27 tokens, exactly as the code comment states. Ruling 23's "once, measured" constraint is honoured to the token.
- **Tool gating.** `selectNormalChatToolsForRequest` spreads every tool in by default and only ever deletes three unrelated, conversation-stable ones (`memory_context`, `use_skill`, `suggest_instruction`) under three specific flags; nothing in it can accidentally withhold the artifact tools, and the new test proves it under `incognito: true` plus both other gates off at once.
- **Tool behaviour.** Structural validation (`patches`/`ops` neither-or-both, the 1…40 cap) refuses before any artifact lookup runs (proven end-to-end through the real tool wiring, not just the domain function). `TOOL_TIMEOUTS_MS` rows match ruling 40 exactly (`create_artifact: 120_000`, `edit_artifact: 20_000`, `read_artifact: 10_000`), and a new hygiene test asserts every enveloped tool in the full catalogue has a row (closing the "missing row = unbounded call" hazard the ruling flagged). Tool-call metadata on success matches the spec's `{artifactId, artifactKind, artifactTitle}` shape exactly.
- **Harness core.** `--replay` never constructs a client (`main()` sets `client = null` before `attemptCase` ever checks it, and `attemptCase` checks `options.replay` before `deps.client`) — no network call is possible in replay mode, confirmed by reading the control flow, not just the tests. The known-bad-first gate (once fixed per finding #4) correctly refuses to trust regular results when a known-bad fixture doesn't fail. `client.ts` is the only module that touches the API key; it is captured in a closure and never appears on the returned client object (`Object.keys` proof in `client.test.ts`), never logged, and no test in the diff reads the real `~/.config/opencode/opencode.json` — all fixture-based or pointed at a provably-missing path. `results.json`'s shape (`EvalSuiteReport[]`) structurally cannot carry a key. `--out`/`EVAL_ARTIFACTS_OUT` uses `resolve(cwd, outDir)`, so an absolute path is honoured as given. `scripts/eval-artifact-contracts/results/*` was already gitignored by Slice 0; 5a needed no change there.
- **Live smoke (optional, done).** Opened and closed the tunnel in one command (`ssh -N … -L 30570:192.168.1.96:30000 alfyroot & … kill`), ran a one-off `npx tsx` script calling `resolveEvalArtifactsClient({baseUrl: "http://127.0.0.1:30570/v1", model: "qwen3-6-27b", apiKey: null})`. The request (temperature/top_p/top_k/max_tokens, `chat_template_kwargs: {enable_thinking:false}`, no `Authorization` header) was accepted and returned a clean `"PONG"` with no leaked `<think>` content — the harness client's request shape works against the real backend.

## Open questions for the orchestrator (no code changes — spec is genuinely silent or this is a design call)

1. **A "full" `read_artifact` has no size bound.** The generic (no-per-kind-handler) branch in `read.ts` returns `body: record.body ?? undefined` uncapped, and `executeToolWithEnvelope`'s `compactModelPayload` only strips empty keys — it never truncates. A stored artifact body can be large (ruling 47 mentions "up to 2 MiB" per version), and nothing in slice-5.md's Limits table bounds a `"full"` read's output. Today this is dead code (no creatable kind has a handler yet, so only File — already capped at 280 chars — is reachable), but it becomes live the moment Slice 1 registers a Document reader. Recommend a bound be decided (and where — `read.ts`, or a generic tool-result cap in `shared.ts`) before a type slice's reader ships, rather than each type slice guessing its own number.
2. **No per-turn cap or idempotency on `create_artifact`.** Compared against `produce_file`'s `MAX_SAME_TURN_PRODUCE_FILE_SUBMISSIONS`/`MAX_PRODUCE_FILE_SUBMISSIONS_PER_TURN`/idempotency-by-`turnId` — `create_artifact` has none of that; `turnId` is threaded through to the (currently empty) handler registry but nothing in 5a's own code uses it for dedup or a cap. Slice-5.md's "Non-goals"/"Cost discipline" sections only say the *existing* produce_file caps are unchanged; they never state a new create_artifact cap is required. Harmless today (every kind instant-refuses), but once Slice 2 wires a 120-second App-generation handler, an unbounded loop of `create_artifact` calls in one turn has no guard. Worth an explicit decision (a cap, idempotency, or a deliberate "no cap needed because X") before that lands, not an invented number from me.
3. **Runtime refusal strings (per-kind "not yet"/App/File messages in `create.ts`/`edit.ts`) are English-only**, unlike the tool's top-level `description`/`errorPrefix`. This matches an explicit, precedented convention already in the code (the comment at `create.ts`'s `ARTIFACT_KIND_LABELS`: "mirroring every other tool's field-level `.describe()` text: only the top-level TOOL_I18N description/errorPrefix are bilingual") and how every other existing tool's runtime-only strings behave — the model is expected to translate the reason into the user's language itself. I read this as intentional and consistent, not a defect, but flagging it since the hunt list named "per-kind refusal framing … in both languages" explicitly.
4. **`resolveEvalArtifactsClient`'s opencode-fallback is all-or-nothing, not per-field.** If `EVAL_ARTIFACTS_BASE_URL` and `_MODEL` are both set but `_API_KEY` is not, `client.ts` never consults `opencode.json` for a key (the whole `fromExplicitConfig` object is used as-is). Slice-5.md's config table doesn't specify per-field vs. all-or-nothing fallback. Low-severity (worst case: a real request sent with no `Authorization` header when one was needed, i.e. a loud 401, not a leak) — noting it rather than guessing the intended merge semantics.
5. **`listArtifactCatalogueEntries` runs more queries than the catalogue needs** (it delegates to `listArtifactsForConversation`, which also computes `versionNumber`/`commentCount`/a generated-file join the catalogue never uses) rather than a single dedicated query. Not N+1 (bounded, fixed query count regardless of artifact count) and I'd keep it this way: reusing the already-scoped, already-tested function is exactly what gave the catalogue correct containment for free, unlike finding #1's `getArtifact` reuse. Noting only because the hunt list asked about query shape explicitly.

## Gate summary

Full gate run at final HEAD `8aba3d9a` (`bash gates.sh …/rv-5a 5570 rv-5a`), plus one standalone re-run of biome and `npm test` after the run because a lint fix (see below) landed on disk mid-run:

```
gates rv-5a at 81699f93 test(artifacts): pin the catalogue read's incognito containment — start 00:31:39
check      exit=0 :: COMPLETED 7768 FILES 0 ERRORS 17 WARNINGS 3 FILES_WITH_PROBLEMS
biome      exit=1 ::                                    [STALE — see below]
migrations exit=0 :: All schema tables have corresponding migrations.
test       exit=0 ::  Test Files 822 passed | 1 skipped (823)  Tests 12364 passed | 2 skipped (12366)
build      exit=0 :: unused-css=32 aria=2 (baseline 32/2)
fallow     exit=0 :: total=124 circular=4 new_vs_baseline=0 gone_vs_baseline=0
playwright exit=0 ::  22 passed (38.5s)
done 00:34:47
```

**The `biome exit=1` line is stale, not a real regression.** The gate script's `git log` header shows it started
at `81699f93`, one commit before `8aba3d9a`: this review's own new tests (the surrogate-pair regression lock and
the newline-injection test in `catalogue.test.ts`) tripped two dead `biome-ignore` comments and one formatter
preference. That was fixed in `8aba3d9a` — landed on disk while the background gate run was already past its own
biome step — and independently re-verified twice after, both clean:

```
$ npx biome check src scripts tests   (at 8aba3d9a)
Checked 1945 files in 549ms. No fixes applied.

$ npm test   (at 8aba3d9a, full standalone re-run)
Test Files  822 passed | 1 skipped (823)
     Tests  12364 passed | 2 skipped (12366)
```

Every other gate number matches or improves on the recorded 5a baseline at `cb9a0775` (0 errors/17 warnings,
12,356→12,364 tests — the +8 is exactly this review's own new tests, test count only grew, build 32/2 unchanged,
Fallow 124/4/+0/+0 unchanged, Playwright chat+conversation 22 passed unchanged). `npm run check:migrations` passes
with no new table. Nothing outside `src`, `scripts`, and `tests` was touched, and no `ALLOWED_WITHOUT_SCOPE` entry
was added.

## Branch

`feat/artifacts-s5a-review`, HEAD `8aba3d9a`, 11 commits on top of `cb9a0775` (4 fixes with their red tests, one
doc correction, one coverage-only addition, one lint-only follow-up — see the findings table for the four
substantive ones' hashes).
