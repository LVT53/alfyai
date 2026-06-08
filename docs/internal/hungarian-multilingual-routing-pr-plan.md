# Hungarian multilingual routing fix plan

Status: internal implementation plan before code changes.  
Scope: split the Hungarian inconsistency work into two reviewable PRs so the first PR fixes the most likely production bug sources without a broad orchestration refactor.

## Background

Observed recurring failures are not likely caused by a single model weakness. Hungarian turns currently stress several English-first orchestration assumptions before the selected model is called:

- custom `detectLanguage()` result is reused as response/tool/deliberation language;
- document and attachment routing regexes are mostly English;
- memory/history query tokenization is ASCII-only;
- project/report memory-context routing is English-only;
- retrieval/reranking use the raw Hungarian query without a multilingual fallback;
- prompt budgeting has protected sections that can bypass normal target-budget pressure.

The first PR should be conservative and testable. The second PR should make the language/context flow more architectural.

---

## PR 1 — Hungarian parity for intent routing and memory lookup

Proposed title: `fix: improve Hungarian routing and memory lookup`

### Goal

Fix the highest-probability Hungarian-only regressions without changing the model-call architecture. PR 1 should make Hungarian requests behave like equivalent English requests for document tasks, attachment tasks, project/report memory context, and account-history lookup.

### Non-goals

- Do not replace Honcho.
- Do not introduce a new LLM classifier.
- Do not refactor normal-chat into a new per-turn language-state object yet.
- Do not change provider adapters or model selection.
- Do not overhaul prompt budgeting in this PR, except where tests expose a small safe fix.

### Files likely to change

- `src/lib/server/utils/prompt-context.ts`
- `src/lib/server/services/chat-turn/context-selection.ts`
- `src/lib/server/services/memory-context.ts`
- `src/lib/server/services/memory-context/project.ts`
- related tests under:
  - `src/lib/server/services/chat-turn/context-selection.test.ts`
  - `src/lib/server/services/context-access-regression.test.ts`
  - `src/lib/server/services/memory-context*.test.ts` if present, otherwise add focused tests near the modules

### Implementation details

#### 1. Unicode-safe memory/history query tokenization

Current issue: history query tokenization matches only ASCII-like terms, so accented Hungarian words are partially dropped or ignored.

Change:

- Replace ASCII token extraction in `tokenizeQuery()` with a Unicode-aware matcher, likely `/[\p{L}\p{N}%_\\]+/gu`.
- Keep the SQL escaping behavior for `%`, `_`, and `\\`.
- Add Hungarian stopwords so broad Hungarian queries do not match too much irrelevant history.
- Keep English stopwords unchanged.
- Consider normalizing whitespace and lowercasing with Unicode support; do not aggressively remove accents unless both stored text and query matching are normalized similarly.

Suggested Hungarian stopwords, minimum:

```txt
az, a, egy, és, vagy, hogy, de, ha, akkor, mert, nem, van, volt, lesz, ezt, azt, itt, ott, nekem, neki, róla, erről, arról, kérlek, tudsz, tudnál, mondd, mondj, mi, mit, milyen, hogyan, hol, mikor, melyik
```

Acceptance examples:

- `kerékpár biztosítás` should produce usable terms including `kerékpár` and `biztosítás`.
- `felmondási idő` should produce usable terms including `felmondási` and `idő`.
- `önéletrajz Roche` should preserve `önéletrajz` and `roche`.

#### 2. Hungarian document task intent

Current issue: document-task detection in `context-selection.ts` is English-first. Hungarian document instructions may be treated as non-document turns.

Change:

- Expand `DOCUMENT_TASK_INTENT_RE`, `DOCUMENT_ANSWER_INTENT_RE`, and `DOCUMENT_REFERENCE_RE` with Hungarian equivalents.
- Prefer readable composed regex constants if the combined regex becomes too large.

Minimum Hungarian action coverage:

```txt
összefoglal, foglald össze, összegezd, elemezd, ellenőrizd, nézd át, javítsd, írd át, szerkeszd, fordítsd, hasonlítsd, alakítsd át, exportáld, készíts belőle
```

Minimum Hungarian document/reference coverage:

```txt
dokumentum, doksi, fájl, file, pdf, csatolmány, melléklet, forrás, ez, ezt, ebből, abban, benne
```

Minimum Hungarian answer coverage:

```txt
mit mond, mi szerepel, mi van benne, alapján, szerint, honnan, melyik, mikor, ki, miért, hogyan
```

Acceptance examples:

- `Foglald össze ezt a PDF-et.` should be document-focused.
- `Mit mond ez a fájl a felmondási időről?` should be document-focused.
- `Fordítsd le ezt a dokumentumot angolra.` should use task-context depth, not a tiny excerpt.

#### 3. Hungarian attachment context mode

Current issue: `selectAttachmentContextMode()` in `prompt-context.ts` only recognizes English attachment task actions and references.

Change:

- Expand `ATTACHMENT_TASK_ACTION_RE` and `ATTACHMENT_TASK_REFERENCE_RE` with the same Hungarian action/reference families.
- Keep behavior unchanged for English.

Acceptance examples:

- `Foglald össze ezt a csatolmányt.` returns `task`.
- `Elemezd a fájlt.` returns `task`.
- `Mit gondolsz?` with an attachment but no document reference can remain `excerpt`.

#### 4. Hungarian project/report memory-context routing

Current issue: `getProjectMemoryContext()` chooses report mode based on English regexes for report/file/project-folder queries.

Change:

- Add Hungarian equivalents to `PROJECT_REPORT_QUERY_RE` and `PROJECT_FOLDER_QUERY_RE`.

Minimum Hungarian report/file terms:

```txt
jelentés, riport, pdf, dokumentum, doc, docx, fájl, export, letöltés, összefoglaló, foglalj össze, írd meg, készíts
```

Minimum Hungarian project/folder terms:

```txt
projekt, projektmappa, mappa, munkaterület, workspace, memória, korábbi beszélgetések, kapcsolódó beszélgetések
```

Acceptance examples:

- `Készíts jelentést a projektmappa korábbi beszélgetéseiből.` should route to project report mode.
- `Foglalj össze mindent ebből a projektből.` should find project/folder context when available.

#### 5. Tests

Add focused unit/regression tests for the above behavior. Tests should avoid network calls and model calls.

Suggested test cases:

```txt
mi ez?
ez mi?
Foglald össze ezt a PDF-et.
Mit mond ez a fájl a felmondási időről?
Fordítsd le ezt a dokumentumot angolra.
Keress rá a korábbi beszélgetéseimben a kerékpár biztosításra.
Készíts jelentést a projektmappa korábbi beszélgetéseiből.
```

Minimum assertions:

- Hungarian document task messages activate document-focused/task context path where the module exposes that behavior.
- Hungarian attachment messages select `task` mode.
- Hungarian history queries preserve accented terms.
- Hungarian project/report messages choose report/project context mode.
- Existing English tests still pass.

### Risks

- Adding broad Hungarian words like `ez`, `ezt`, `benne` can over-trigger document mode if not combined with task/document signals.
- Unicode SQL `LIKE` matching behavior may vary by SQLite collation/lowercase behavior. Avoid relying on perfect Unicode case folding beyond preserving the term.
- Tests should verify deterministic functions first, not full model behavior.

### PR 1 done criteria

- Unit tests added for Hungarian parity.
- No provider/model code changed.
- No Honcho API behavior changed.
- All existing tests still pass locally/CI.
- PR description clearly states this fixes orchestration/routing, not model quality.

---

## PR 2 — Per-turn language state and multilingual retrieval hardening

Proposed title: `refactor: centralize per-turn language and retrieval state`

### Goal

Make language handling deterministic and observable across the full turn. Avoid repeated ad hoc `detectLanguage()` calls and introduce a consistent multilingual retrieval strategy for Hungarian.

### Non-goals

- Do not migrate away from Honcho.
- Do not introduce a new memory provider.
- Do not rewrite the entire chat pipeline.

### Files likely to change

- `src/lib/server/services/language.ts`
- `src/lib/server/services/normal-chat-context.ts`
- `src/lib/server/services/chat-turn/plain-normal-chat-model-run.ts`
- `src/lib/server/services/chat-turn/streaming-normal-chat-model-run.ts`
- `src/lib/server/services/chat-turn/depth-clarification.ts`
- `src/lib/server/services/normal-chat-tools/index.ts`
- retrieval-related modules that accept raw query text
- context trace/debug types if needed

### Implementation details

#### 1. Create a per-turn language-state object

Introduce a small object computed once near the beginning of normal chat turn preparation.

Possible shape:

```ts
type TurnLanguageState = {
  userLanguage: 'en' | 'hu';
  confidence: 'high' | 'medium' | 'low';
  detectionReasons: string[];
  explicitResponseLanguage: 'en' | 'hu' | null;
  responseLanguage: 'en' | 'hu';
  retrievalQueries: {
    original: string;
    normalized?: string;
    englishBridge?: string;
  };
};
```

Rules:

- Compute once from the latest user message.
- Pass the result through context preparation, tools, deliberation, title generation, and clarification.
- Stop repeated direct calls to `detectLanguage(params.message)` in separate modules unless there is a clear reason.
- Add trace/debug output showing the detected language and confidence.

#### 2. Improve short Hungarian detection

Current issue: short-input detection requires whole-message exact match.

Change:

- Tokenize short messages and detect if any meaningful token is a Hungarian short word.
- Handle short multi-token Hungarian messages like `mi ez?`, `ez mi?`, `jó ez?`, `nem kell`.
- Add tests for short Hungarian utterances.

#### 3. Explicit language override handling

Detect explicit response-language instructions separately from user-message language.

Examples:

- `Írj egy angol emailt` means user language is Hungarian, response artifact language may be English.
- `Answer in English: ...` means response language English even if surrounding context is Hungarian.
- Retrieval language should not necessarily equal final answer language.

#### 4. Dual retrieval for Hungarian

For Hungarian turns, retrieval should not depend only on the raw Hungarian query.

Possible low-risk approach:

- Keep original Hungarian query.
- Add a normalized/accent-preserving keyword query.
- Optionally add an English bridge query only for memory/artifact retrieval if a cheap deterministic mapping or configured model is available.
- Merge and dedupe retrieval candidates before reranking.

Important: do not make every Hungarian turn call an LLM translator. If translation is added, make it optional/configured and cached.

#### 5. Prompt-budget hardening

Move this here unless PR 1 uncovers an urgent small fix.

Targets:

- Make `serializeBudgetedRoleTurns()` actually enforce `maxTokens`.
- Change protected sections from `always full include` to `must include but can be trimmed`.
- Add hard final budget diagnostics before provider call.
- Expose budget decisions in context trace for debugging.

#### 6. Observability

Add logs/context-trace fields for:

- language state;
- retrieval query variants used;
- document/attachment intent result;
- memory_context mode selected;
- whether Hungarian parity rules fired;
- final prompt estimated tokens and budget status.

### Tests

Add integration-style tests that prepare outbound context without calling models. The tests should compare Hungarian and English equivalent messages.

Suggested pairs:

```txt
Summarize this PDF. / Foglald össze ezt a PDF-et.
What does this file say about notice period? / Mit mond ez a fájl a felmondási időről?
Search my past conversations for bike insurance. / Keress rá a korábbi beszélgetéseimben a kerékpár biztosításra.
Create a report from this project folder. / Készíts jelentést ebből a projektmappából.
```

Minimum assertions:

- Same class of context sections selected.
- Same memory mode selected.
- Same attachment mode selected.
- Final prompt fits configured model budget.
- Language state is stable across the turn.

### Risks

- Centralizing language state touches many modules and may cause broad test churn.
- Dual retrieval can increase retrieved noise if not deduped and reranked carefully.
- Prompt-budget hardening may reduce context in existing English workflows; trace output is needed to debug that safely.

### PR 2 done criteria

- One language-state object controls normal chat turn language behavior.
- Repeated `detectLanguage(params.message)` calls are removed from normal chat orchestration paths.
- Hungarian and English parity tests exist for context preparation.
- Retrieval behavior is observable and does not silently change based only on final response language.
- Prompt-budget protection is bounded and traceable.

---

## Later work, not PR 1 or PR 2

- Evaluate Honcho alternatives or replacement memory providers.
- Add periodic LLM-based memory consolidation/dreaming with explicit keep/drop/contradiction rules.
- Add a full multilingual intent classifier.
- Add offline multilingual embedding/reranking benchmarks.
- Add UI diagnostics for per-turn language/retrieval/memory state.
