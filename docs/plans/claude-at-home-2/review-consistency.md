# Consistency review — the seven slices, the plan and the rulings

**Scope:** `decisions.md` (42 rulings, untouchable), `plan.md`, `slice-0.md` … `slice-6.md`, the parent spec
(`../claude-at-home-2-artifacts-spec.md`) and the three mockups, read against the real tree. Every fix here is
docs-only: no ruling was changed, no slice was restructured, and nothing was committed. Where a ruling and the
tree disagree, the ruling was left alone and the disagreement is written up below.

**Method:** the 13 known defects were fixed first, then the same class of defect was hunted across the whole
set — the same file owned by two slices, contracts that disagree (fields, status codes, error bodies, timeouts),
ownership tables that disagree about who lands what first, gate lists that differ between `plan.md` and a slice,
claims about the repo that are false, and every `path:line` citation checked by reading the code at that line
(342 distinct citations; the ones checked line-by-line are listed as *verified* below).

---

## 1. Fixed

### Contract and naming seams

| File | What changed |
|---|---|
| `slice-0.md` | `artifacts.type.canvas` is **`Canvas`** / `Tábla` (ruling 20); the whole `artifacts.kind.*` family is gone and named as gone. `ArtifactCardSummary` is the card summary, no alias against `knowledge/types.ts`'s `ArtifactSummary`. The boundary is `services/artifacts/index.ts` — **a directory**, not the spec's single `services/artifacts.ts` (AGENTS.md forbids a new top-level `services/*.ts`), noted so nobody "fixes" it back. Ruling 37's four defects. §Routes now carries the family envelope: `{ ok: true, … }` / `{ ok: false, reason, … }`, the 404 body is `{ ok: false, reason: "not_found" }`, and the file says **not** to route these failures through `createJsonErrorResponse` (its body is `{ error }` — `src/lib/server/api/responses.ts`). |
| `slice-1.md` | The false "`…/document/patches` answers 400 `{ ok: false, reason: "invalid_patch" }` **through `createJsonErrorResponse`**" claim dropped — that helper cannot produce the body the same sentence asserts. `RefusalNotice.svelte` moved from the implied `document/` directory to its real shared root `src/lib/components/artifacts/RefusalNotice.svelte`, plus a File-ownership row: **this slice creates it, slices 3–4 consume it**. |
| `slice-2.md` | Three route tests renamed to the repo's own convention — `app/app.test.ts`, `app/kv/kv.test.ts`, `app/regenerate/regenerate.test.ts` (slices 1 and 3 already name theirs `ops.test.ts`, `export-png.test.ts`, `refresh.test.ts`; 168 route tests in the tree, none named `server.test.ts`). The App serve route's hand-rolled `try { requireAuth } catch { 401 }` is gone: it now calls `requireAuth` bare and answers the family's `{ ok: false, reason: "not_found" }`, which is what this slice's own Contracts row already promised for that route. Auth now **names its layer** in the test row and in Task A4 step 1 (ruling 19): the handler layer sees `requireAuth`'s **302**, the **401** is `hooks.server.ts`'s answer to an unauthenticated `/api/**` fetch. |
| `slice-3.md` | Same `createJsonErrorResponse` claim dropped on the ops route (it maps `status`/`reason`, so its failure body is the family's). The Canvas refusal notice now **names** the component it renders — Slice 1's shared `RefusalNotice.svelte` — plus a consumer row in File ownership, so slice-4's "slices 3 and 4 import it" is true. |
| `slice-4.md` | ``requireAuth` → 401` corrected: `requireAuth` throws the **302**; the 401 belongs to `hooks.server.ts` (ruling 19). Earlier in this pass: the panel spec name, `npx tsx` over `node --experimental-strip-types`, the ops response envelope, the `RefusalNotice` "do not create" row, the serialisation order, and the i18n family citation. |
| `slice-6.md` | Ruling 32 (replay lives in the panel — the artifact list's menu and the type's empty state; the version affordance is **not** a host), ruling 33 (an incognito chat shows no tour at all; the seen state is user-scoped, archived and erased; no "don't show again" switch), ruling 31 (the containment suite and the panel spec are slice 0's, appended to by 5 then 6), ruling 15 (`src/lib/components/artifacts/`), and the family envelope on all three tour routes. All four open questions are recorded as ruled rather than re-opened. Stale citations fixed: `schema.ts:2213→2214`, `SlideEditor.svelte:37→43`, `campaigns.ts` ranges, `announcement-campaigns.ts:1065-1084→1076-1094`, `auth/hooks.ts:16-20→9-15` (that range is `getBearerToken`), `admin/campaigns/_shared.ts:4-15→4-13` (the file is 13 lines). |
| `plan.md` | Wave 5 loses tours; **Wave 6 / Slice 6** added with rule 30's reasoning; the schema and drizzle rows name slice 6's `artifact_tour_states`; the containment-suite row states ruling 31's append-only rule; the user-scoped-table row names slice 6 (ruling 33); the version-badge line moves to the panel's replay entry (ruling 32); decision 17's citation is `no-ad-hoc-maps.test.ts:164` only (ruling 10's correction). |

### The 13 known defects, closed

Ruling 37's slice-0 defects; ruling 26's panel spec name (`tests/e2e/artifacts-panel.spec.ts` everywhere);
ruling 27's heading citations (**no** `slice-N.md:<line>` citation remains in any file); ruling 15's plural
component directory; ruling 30's tours → Slice 6; ruling 31's shared suites; ruling 22's single i18n family
(`artifacts.type.*`, owned by slice 0); ruling 40's single `create_artifact: 120_000` row in slice 5's registry;
ruling 41's `normal-chat-tools/index.ts` landing order (5 → 2 → 1, stated identically in slices 1, 2 and 5);
slice-5's `--skip-model` claim (the prototype's switch is the env var `PROTO_APPS_SKIP_MODEL=1`, no CLI flags);
ruling 13's `body` field across slices 3–5; ruling 20's `ArtifactCardSummary` and label list; the mockup section
numbers (checked in slice 6 — correct).

---

## 2. Not fixed — needs an owner decision

**Q1. One auth helper per family, or two?** Slices 0–5 declare `requireAuth` (`auth/hooks.ts`, which **302s**);
slice 6 deliberately declares `requireApiUser` (`api/auth.ts:10-22`, which **throws 401**) and asks for the
deviation to be recorded here. `src/lib/server/api/auth.ts`'s own header says `requireAuth` is "**WRONG** for a
`fetch` to a JSON endpoint"; 16 routes in the tree follow it, 129 still call `requireAuth`. All six slices' routes
are panel/iframe fetches, so the distinction is real in principle and cosmetic in practice: the session gate in
`hooks.server.ts` answers an unauthenticated `/api/**` request with **401** + `x-session-expired: 1` **before**
any route runs, so what a *user* sees is the same. The bodies differ (hook: `{ error, code }`; `requireApiUser`:
`{ message: "Unauthorized" }`) and both are read by `client/api/http.ts`'s `readErrorPayload`
(`parsed.error ?? parsed.message`) — which is why I changed no slice's helper. *Recommendation:* make it one
choice for the family — `requireApiUser` for all of them matches the API seam module's stated rule and gives a
machine-readable 401 at every layer — and land that as a small edit to slices 0–5's route declarations rather
than leaving slice 6 as a lone deviation. I did not make that call: it rewrites five slices' route contracts.

**Q2. Ruling 31 says slice 0 *creates* the containment suite — the file already exists.** 
`tests/cross-cutting/incognito-artifact-containment.test.ts` is in the tree (669 lines) and already carries
artifact coverage; slice 0's real job is PART B plus PART A additions. The slices hedge honestly (slice 3 says
"extend — the file already exists in-tree, 669 lines"), and the plan now says "0 creates it … 5 and 6 append".
*Recommendation:* read "creates" as "creates PART B", or reword the ruling's phrasing; either way, do not let an
implementer write a second guard file beside the existing one. Ruling untouched.

**Q3. The parent spec carries two things the rulings have since dropped.** §3's `metadata_json` sketch has
`idIndex?` (ruling 37 dropped it; slice 0 and slice 1 both say so) and the spec's facade is a single
`services/artifacts.ts`, which the slices replace with `artifacts/index.ts` for the AGENTS.md reason. The slices
are right; the spec is stale. *Recommendation:* update the spec's §3 sketch and its "where the code lives"
paragraph, or mark them superseded — the spec is outside this review's edit scope.

**Q4. Ruling 28's citation no longer points at what it claims.** 
`file-production/read-model.ts:491` is `export async function listConversationFileProductionJobs(`;
`idempotencyKey` appears nowhere in that file. The ruling's *substance* holds — the projection directly above
(`:485-490`) maps `dismissed` / `error` / `sourceMode` and drops the key — and slice 4's own citation of `:491`
is correct. Ruling untouched; no slice reproduces the wrong reading.

**Q5. `artifacts.` label names are the owner's; one more is worth a look.** Ruling 20 fixes English `Canvas`
with Hungarian `Tábla`. Every slice now uses that pair, and slice 3's i18n table uses it as the board's type
name. No action needed unless the owner prefers `Board` in English — in which case the fix is one row plus the
note in slice-0 §i18n, not a slice rewrite.

---

## 3. Verified genuinely fine (no edit made)

- The two-writer guard: `expectVersion` (a number) on `PATCH …/body`, `baseVersionId` on `POST …/ops` — slice 3
  reconciles the pair explicitly, and slices 1, 2, 3 and 4 agree on both spellings and both 409 bodies.
- The i18n ownership chain: slice 0 registers `src/lib/i18n/artifacts.ts` in `I18N_MODULES` and adds
  `"artifacts."` to `AUDITED_PREFIXES`; slices 1–5 append keys only. `i18n.test-helpers.ts` really is
  `I18N_MODULES` at `:7`, `AUDITED_PREFIXES` at `:16`.
- `normal-chat-tools/shared.ts:196` (`TOOL_TIMEOUTS_MS`) and `:343-350` (a name with no row runs **unbounded**)
  — exactly ruling 40's premise.
- `announcement-campaigns.ts:1404` / `:1496` return `{ campaign, created }` as slice 6 claims;
  `_shared.ts` really is the `campaignErrorResponse` shape slice 6's admin seed route shares.
- The boundary symbols the slices lean on: `knowledge/store/core.ts:141` is `getArtifactOwnershipScope`;
  `chat-files.ts:1113` is `readChatFileContentByUser`;
  `working-document-file-serving.ts:35` is `resolveWorkingDocumentFileServing`;
  `file-production/intake.ts:480-503` is the `conversationId` guard; `account-data-archive/index.ts:74-79` is
  `EXCLUSION_NOTES`; `account-lifecycle/user-scoped-tables.ts:389-404` is the campaign rows slice 6 anchors on.
- Slice 4's deployment citations: `SANDBOX_PYTHON_PACKAGES` (`sandbox/python-version.ts:40-45`),
  `sandbox-python-version.sh:39,42`, `verify-sandbox-packages.sh:59`, and the `deploy-lib.sh:538` warning — all
  exact. `package.json:91` is `pptxgenjs`, and slice 3's "not in `package.json` today" grep claim is true.
- Slice 1's prototype pointers: the worktree `agent-a883f7e86c2b442fd` exists on
  `proto/artifact-document-editor-r2`, and the reading trap is real — `file-production/source-schema.ts` is
  binary (a NUL byte), the block union starts at `:1`, and `GeneratedDocumentSource` is at `:235`.
- No file is created by two slices: each e2e spec, integration test and shared module has one creator and
  named appenders, and `artifact-bodies.ts` is `0 → 1 → 2 → 3 → 4`, one line each, in every slice that mentions
  it.

## 4. Judgement

Slices 0–4 are ready to hand to implementers: every contract in them is single-sourced, every citation I could
check resolves, and the two seams that mattered (the family error envelope and the auth layer) now say the same
thing in every file. **Slice 5** is ready with one caveat — its tool registration order is right, but it is the
only slice whose prototype pointers live on a branch rather than in the tree, so its first task should be
reading `proto/artifact-apps-quality`. **Slice 6** is the one I would not hand over before Q1 is settled: it is
the only slice that knowingly deviates from the family's auth helper, and its routes are the feature's newest
surface. Its tours content, replay host and incognito rule are otherwise fully consistent with rulings 30–33.
