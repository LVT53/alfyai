# FB-2 — Alfy's tools and words (F2, F10, F20, F22, LV's App brief)

Model: Claude Sonnet 5.5 (`claude-sonnet-5-5`). Worktree `art-fb2`, branch `fix/friction-tools`, from `7be9d42a`.
Commits `7be9d42a..701898bf` (8; every message says why and carries the trailer):

| Commit | What |
|---|---|
| `07c7843a` | **F2**: `edit_artifact` on an App rebuilds that App in place |
| `fce54440` | **F10**: "a document" with no format named is the in-app Document; one job per requested output |
| `5469edc9` | **LV's App brief**: an App's create call carries a brief, never its HTML |
| `ca97881c` | **F20**: "Open as document" titles at a word or sentence end |
| `18f11a1a` | **F22**: no ids and no English in a Hungarian turn's rows and status lines |
| `f8aa8ccf` | F2 follow-up from the live check (the model parroted "about a minute") |
| `c56172f1` | F22 follow-up from the live check (the tether itself was the leak: "dark background") |
| `701898bf` | the eval's `edit_artifact` simulation kept in parity (the agent gate's vitest step), harness formatted |

## F2 — what changed, and the App edit path's audit (for the Opus look)

**The path, in order** (a chat turn: "change this App"):

1. `edit_artifact` takes a new optional `instruction` (`artifact-tools/edit.ts`: `appInstructionSchema`, min 1 / max 4,000, one schema object used by BOTH the advertised `buildEditArtifactModelInputSchema` and the executed `editArtifactInputSchema`, ruling 62). The description's one App example, `EDIT_ARTIFACT_APP_EXAMPLE` (`kind-prose.ts`), is parsed through both schemas by `edit.test.ts`.
2. `runEditArtifactTool` (unchanged guard): reads the item with `getArtifact` and answers "not found" unless `record.conversationId === params.conversationId` (the tool never reaches another chat's item, incognito included). New: an instruction on a Document/board is refused naming `patches`/`ops`; patches/ops on an App are refused naming `instruction`; both together are refused.
3. `EDIT_ARTIFACT_HANDLERS.app` (`edit.ts`): abort checked first (ruling 53), a per-turn budget of `MAX_APP_REBUILDS_PER_TURN = 2` (an attempt counts, `turnContext.appRebuildBudget`, per `createNormalChatTools` closure like `knownBoards`), then **`regenerateApp`** (`services/artifacts/app/regenerate.ts`) with `{userId, artifactId, conversationId, prompt: instruction, language, abortSignal}`. `language` is the turn's resolved language (ruling 55) or the content-language request (ruling 75), the same expression `create_artifact` uses (`index.ts`).
4. `regenerateApp` is **the one function the panel's route (`POST /api/artifacts/[id]/app/regenerate`) calls**; nothing forks. It re-reads the item through the same scope, then `generateAndVerifyApp` (`app/generate-and-verify.ts`):
   - `generateApp` (`app/generate.ts`) runs **`auditAppHtml`** on every document it generates; a violation-severity rule (self-navigation, WebRTC; `APP_VIOLATION_RULE_IDS`, ruling 58) is retried once with the violation named, then refused as `contract_violation`.
   - `verifyApp` (`app/verify.ts`) fact-verifies and may repair once and re-verify (ruling 52).
   - the repair is audited again: **`appViolations(repair)`** in `generate-and-verify.ts` (a violating repair is refused: verdict `uncertain`, the audited original ships).
5. The write: `updateArtifactBody` (`artifacts/record.ts`) with `author: "alfy"`, `summary: regeneratedAppSummary(prompt)` (History's `app_rebuilt`), `metadataPatch: {glitchRuleIds, verification}`, and — **new** — `expectVersion: current.versionNumber`. Before this the version was compared only at the top of a call that runs for tens of seconds; a write that landed meanwhile (the panel's own rebuild, a History restore, a second call of the same turn) was stacked silently. Now it is refused as `version_conflict` and the result says which version is current (the panel path gets the same, a 409 it already knew how to show). Abort is checked again before the write.
6. Every other App body writer keeps its own audit (body route, restore in `versions.ts`, the served version route); this path adds no writer.

**Things the look should weigh:** (a) the generator now receives the App's stored HTML as context (`AppGenerationRequest.currentHtml`, built in `buildAppRequestMessage`; the system prompt is still `APP_CONTRACT_PROMPT`, one user message, no history): that is model-written App source going back to the same generator under the same output audit, no new privilege; without it the panel's own "Módosítás…" also returned an unrelated app (FA's F02b was not only model quality). This changes the panel path too. (b) `instruction` is model-written text that is the verifier's "request" and, clamped to 500 characters, the version summary History shows. (c) The tool's timeout row is `create_artifact`'s 120 s (`shared.ts`; one row per tool, ruling 40). (d) No route, no file serving, no sandbox/CSP/frame change; the panel reload uses the existing `fetchArtifact`.

**The open panel**: `app/app-rebuild-activity.ts` (new, pure) tells an App rebuild by its `instruction` (running and settled), the chat page's one live-activity scan (`_helpers.ts` `findLiveDocumentAlfyActivity`) tries it first, `AppBody.svelte` takes the `alfyActivity` prop: veil and inert frame while it runs (the panel's own rebuild veil), `load()` once when it lands (the frame reloads on its version). Not done: the panel's own "Alfy rebuilt it · Undo" toast has no chat-driven twin (History's Restore covers undoing).

**Tests (red first):** `edit.test.ts` (App handler, refusals, budget, abort, failure/conflict messages, schema parity), `regenerate.test.ts` (the generator gets the app; `versionId`; a concurrent write is refused), `generate.test.ts` (request message), `app-rebuild-activity.test.ts`, `_helpers.test.ts`, `AppBody.test.ts` + `AppBodyActivityHarness.test.svelte` (a harness that changes only `alfyActivity`: the testing library's `rerender` replaces every prop and re-runs the load effect, so it cannot tell), `index.test.ts` (description, schema, timeout). **Real input:** `tests/e2e/artifact-app-chat-edit.spec.ts` through the real chat and the fake provider; the App generator's call reaches the same fake because the spec points the `model1` provider at it (restored in `finally`), new scenario markers in `tests/fixtures/ai/openai-compatible-scenarios.ts` / `tests/mocks/ai-provider/openai-compatible-provider.ts`. With the panel's reload disabled the spec fails with the old App on screen; passing, it asserts one App, versions `[1, 2]`, `Alfy regenerated the app: …`, the new heading in the open frame, one row in the list.

## F10 — what changed

`create_artifact` and `produce_file` each say it where the model weighs them ("A request for a document with no file format named is a Document: …"; a named format or a download is `produce_file`'s), and the base prompt's tools paragraph (`prompts.ts`, the live prompt) says when `produce_file` is for. The audit's recorded turn shows the cause: the model reasoned "dokumentumot … most naturally means a downloadable document", made a DOCX, read it back, "corrected" it and made a second, 11 bytes different. **Dedupe** (`index.ts`): the first clean success (no warnings) of a requested file (title, outputs, mode, filename; not content) is the answer for the rest of the turn; a resend, even with different content, gets that success with `reused: true` and a note ("already made in this turn … never say a change landed"). A failure, or a success that carried a warning, keeps the correction path (existing tests); a PDF then a DOCX of one title are two requests. **This replaces a pinned behaviour** ("a same-turn corrected resend whose content differs is a new job", `index.test.ts`): ruling 77 says one job per requested output, and only a byte-identical resend was replayed before, which a model that rewrites its file never sends. Parallel same-step calls with different content are not covered (the intake's idempotency key already collapses byte-identical ones).

## LV's App brief

Tool text: `body` for an App is "a brief of what the app is for and does, in the user's words — never HTML (the app is built from it)". `CREATE_ARTIFACT_HANDLERS.app` refuses a body that is markup (`shared/artifacts/app-brief.ts` `looksLikeHtml`: a document start, a fenced html block, or a run of ≥5 tags) before any generation, naming the fix, so the generator never receives the model's HTML as its prompt. Old rows: `deriveMoment` gives an `app_made` moment whose brief is markup no text (the headline was always fixed), nothing to migrate. Live: the real model now sends a Hungarian/English brief (HU-1, EN-1) and version 1's summary is that brief.

## F20

`keep-message.ts` `clipTitle`: ≤ 60 characters as before; else the first sentence if it ends by 80 characters (and is ≥ 20, so "Szia!" is not a title), without its period; else the words that fit near 60 + "…", never leaving a bracket open; a first word longer than a title is cut at 60. The audit's reply → "Szubjektív, de ha egyet kellene mondani, a Café Central…". `keep-message.test.ts` (incl. a never-mid-word loop) and `tests/e2e/artifact-keep-title.spec.ts` (the real button, the title in the panel's name, the composer placeholder and the row; fails on the old code).

## F22

Rows: `read_artifact`'s record carries `artifactTitle`; `utils/tool-activity.ts` gives `read_artifact` and `read_generated_file` a read row "Elolvasva/Read <title>" (a produced file by request title, else file name; no title on an old record says only that it read; repeated reads group as "Elolvasva ×2", not "Eszköz ×2"). The row's expanded body still shows the call's raw arguments (unchanged). Status lines: `short-local-text.ts` (the one cleanup) has `containsInternalIdentifier` (uuid, hash, block id, slug, snake_case, camelCase, code fragment) and `containsEnglishWords` (English function words and the English nouns the audit's model copied; stems match with a ≤ 8-letter Hungarian suffix, never as a prefix of a Hungarian word) behind `leaksInternalNames(text, language)`; the thought-step classifier applies it to the headline and the entity, its prompt says what to copy (a name, a product, a number; never an id, slug or field name; in Hungarian never an English word), and the rail summary rejects ids through `cleanup.rejectIdentifiers`. Both directions are tested on the real entities and headlines of the audit's 16 turns (30 must be caught, 21 must stay: Gloriette, Powerbank, Flash-Next, "DOCX formátumot választott …"). Live check found a hole and `c56172f1` closes it: in a Hungarian turn a word of the English reasoning (lowercase ASCII) can no longer tether a headline, and an entity is shown only if every word is a name/number/acronym or it carries a Hungarian letter; "dark background" now drops.

## Frozen tool catalogue (ruling 23), measured

Descriptions, estimator of `index.test.ts` (en chars/4.0, hu chars/2.9), whole catalogue / `edit_artifact`:

| Step | en | hu | `edit_artifact` en/hu | snapshot files en / hu (B) |
|---|---|---|---|---|
| before (M3 head) | 5,110 | 8,256 | 534 / 817 | 73,065 / 78,338 |
| F2 | 5,144 (+34) | 8,302 (+46) | 568 / 863 | 73,456 / 78,737 |
| F10 | 5,200 (+56) | 8,385 (+83) | 568 / 863 | 73,681 / 78,993 |
| brief (schema field text, not counted) | 5,200 | 8,385 | | 73,766 / 79,078 |
| F2 follow-up (final) | **5,196** | **8,379** | 564 / 857 | **73,753 / 79,064** |

Net spent over the baseline: +86 en / +123 hu tokens. Ceilings: 5,136/8,283/819 → **5,222 en / 8,406 hu / 859 per tool** (measured plus the same margin, 26/27/2; the follow-up lowered them from 5,226/8,412/865 so the freed headroom is not left standing). `produce_file`'s two frozen copies in `format-prose.test.ts` re-frozen.

## Real model (tunnel 30409, `qwen3-6-27b`, production build, scratch DB, real composer input; 11 turns, one at a time)

Kit: `p5/fb2-kit/` (`driver.cjs`, `live.log`, `live-results.jsonl`, screenshots). Outcomes:

| Turn | Result |
|---|---|
| HU-1 "Csinálj nekem egy borravaló-kalkulátor alkalmazást …" | `create_artifact` app; body = a Hungarian brief, v1 summary "Alfy made the app: Interaktív borravaló-kalkulátor magyar nyelven …" (not HTML) |
| HU-2 "Legyen sötét a háttere, és tegyél bele egy Nullázás gombot." (App open in panel) | `edit_artifact` + `instruction`; **one App**, v2 "Alfy regenerated the app: …", same app (currency/percent/split), dark; panel header "Alfy újraépítette · épp most", frame dark (`hu2.png`). Reply said "az újraépítés eltarthat kb. egy percig" for a finished rebuild → follow-up fix |
| HU-3 "Írj nekem egy dokumentumot a bécsi hétvégi útitervünkről." | `create_artifact` **document**, no `produce_file`, no job |
| HU-4 "Csinálj nekem egy PDF-et …" | `produce_file` pdf, exactly **one** job, succeeded |
| HU-5 "Adj hozzá a végére egy csomagolási listát …" | `read_artifact` + `edit_artifact`; row group "Elolvasva", "Szerkesztve Bécsi hétvégi útiterv" (`hu5.png`); no id, no "Eszköz" |
| EN-1..EN-4 (tip app / change it dark + Reset / document / PDF) | the same four outcomes in English: one App at v2 (panel `en2.png`), a Document and no file job, one PDF job |
| HU-6 (after the follow-up build) "Legyen a Nullázás gomb piros." | same App → v3, in place; reply "A frissített változat már megnyílt." (no wait promised) |
| HU-7 "Cseréld le a csomagolási lista utolsó tételét …" | `read_artifact` + `edit_artifact`; expanded row "Elolvasva **Bécsi hétvégi útiterv**", status line "Kérés értelmezése…" with no "(entity)" (`hu7.png`) |

Status-line steps of the five Hungarian turns: no id, no slug, no English word survived except the entity "dark background" in HU-2, which is the hole `c56172f1` closes (the build used for HU-6/7 has it; "Vienna City Card", a proper noun, is kept).

## Gates

`scripts/gates.sh agent … --port 5420 --workers 4` with `artifact-app-chat-edit`, `artifact-keep-title`, `artifact-app`, `artifact-chat-card`, `chat`, `streaming` specs at `c56172f1`: check **0 errors / 17 warnings** (baseline), build **unused-css 32, aria 2** (baseline), chunks OK (editor closure 70.9 kB gzip), Fallow **124 issues / 4 circular, 0 new, 0 gone**, migrations OK, Playwright **64 passed, 0 failed, 0 flaky** (4 workers, 54 s). Two static steps failed in that run and were fixed in `701898bf`: biome (the harness component's format) and one vitest test (the eval's `edit_artifact` simulation must answer like the tool; I changed the tool's "neither" message). After the fix: `biome check src scripts tests` clean, `npm test` **1058 files passed + 1 skipped, 17,945 tests passed + 2 skipped**. I did not re-run the whole agent gate (once, as asked); the later commit touched only the eval script and one test component.

## Deviations, concerns, hand-off

- **Panel path changed too** (the generator now sees the current App; the write is guarded by `expectVersion`); both are the reason F2 is a change and not another app. A race now shows the panel's existing "version_conflict" message.
- **Pinned `produce_file` behaviour replaced** (above); the correction path after a failure or a warning is intact.
- **`read_generated_file` rows** name the request title, else the file name (a slug such as `becsi-hetvegi-utiterv.docx`); an id never.
- The English-word list is a deny-list that grows from real output (like the other status-line guards); the live check already found one miss. The Hungarian entity/tether rules are stricter on purpose (a miss shows a copied word; a hit only drops a headline to the phase label).
- F10 is verified with one sample per phrasing live (HU/EN "document" → Document, "PDF" → one file); "riport/jelentés" and other words for the same ask are untested. The model also made an unasked typo-fix `edit_artifact` on a fresh Document in HU-3 (v2): model behaviour, not touched.
- `AGENTS.md` is not edited (the artifacts section is shared by every agent of the batch): a sentence is due there that an App is changed by `edit_artifact` + `instruction` through `regenerateApp`, and that `app-rebuild-activity.ts` tells the panel.
- Hand-off: `buildAppRebuildActivity` (`components/artifacts/app/app-rebuild-activity.ts`), `AppBody`'s `alfyActivity` prop, `regenerateApp`'s `versionId`, `leaksInternalNames` / `cleanup.rejectIdentifiers` (`chat-turn/short-local-text.ts`), `looksLikeHtml` (`shared/artifacts/app-brief.ts`), `MAX_APP_REBUILDS_PER_TURN` (`edit.ts`).
