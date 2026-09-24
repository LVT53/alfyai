# Atlas v3 reasons from an evidence bank, not from search excerpts

> Keeps [ADR-0036](0036-atlas-is-normal-chat-turn-not-parallel-subsystem.md) (Atlas is a Normal Chat Turn plus one in-process worker), [ADR-0052](0052-replace-searxng-web-research-with-parallel-search.md) (Parallel backend) and every piece of job infrastructure [ADR-0062](0062-atlas-content-pipeline-is-rebuilt-on-the-harness-tools.md) kept. It **replaces** ADR-0062's content pipeline for jobs stamped `pipeline_version: 3`.
>
> **Amended (Phase B of the v3-only consolidation, see below).** "v1 and v2 stay runnable, unchanged" no longer holds: both were deleted and Atlas now runs v3 exclusively for every job, old and new. `ATLAS_PIPELINE` is gone; rollback is the `atlas-v1-v2-final` tag, not a config value.
>
> **Amended (Phase C, see below).** Stage 2's bank also holds the user's own documents as `user_document` sources on one collapsed publisher, with a local verbatim guard and library chips; the identity functions it reuses now live in v3 itself (`atlas-v3/source-filters.ts`, `publishers.ts`), not in v2.
>
> **Amended (Phase D, see below).** Continue and Revise children reuse the parent's evidence bank after a deterministic freshness recheck; a Fork re-researches; a v1/v2 parent seeds its child from its published report's source URLs, read afresh.

## Context

v2 delivered verifiability: across thirteen audited runs citation resolution was 100%, number match 88–100%, junk sources ~0. It did not deliver a report worth reading. The audit of those thirteen runs found six causes, none of them prompt wording:

1. **The section is the unit of work.** One model call over a bag of snippets, with a rule that forbids a figure inside any sentence that synthesises. There is nowhere for "therefore" to happen.
2. **Evidence is search excerpts, not reading.** One page per question, 1,500-character excerpts, a marketplace nav menu peered with an iFixit teardown. Nothing is a *structured claim*, so no table can be built.
3. **Verification only deletes.** A figure absent from its source cuts the sentence; nothing asks for better evidence.
4. **The writer never sees the report.** Sections are written blind to each other; the executive summary was silently lost in 13 of 13 runs.
5. **Sections are evidence buckets, not arguments.** Two questions with the same sources become two near-identical sections; series differences are reported as "sources disagree".
6. **Budgets are per-profile, not goal-driven.** Research stops after a round count, never because the core figures are in hand from two independent publishers.

The 2025–2026 literature converges on five scaffolding lessons that are implementable by prompting alone on a mid-size local model: rebuild the workspace every round rather than growing a transcript; keep verbatim evidence in a keyed bank and bind citations to outline nodes, writing then pruning; co-evolve outline and research; fan out for research and never for writing; and run a critic that re-searches rather than a "check your work" prompt.

## Decision

**Add `atlas-v3`, selected by `ATLAS_PIPELINE=v3` and stamped on the job row as `pipeline_version: 3`. Make the claim, not the section, the unit of work: research produces keyed verbatim quotes and structured claims in an evidence bank, an answer table is assembled before any prose, one writer writes the report section by section with the whole report in view, and a critic with a failure taxonomy may order targeted re-search before anything is cut.**

### Stages

1. **Ask** (`ask.ts`) — one control-model call restates the request as a decision and returns implicit requirements, stakeholder perspectives, the report's shape (comparison / explanation / forecast / timeline / mixed), the core question and a title. Thinking off, tight cap, deterministic fallback derived from the request.
2. **Evidence bank** (`evidence-bank.ts`) — keyed verbatim quotes (`e12`) carrying url, title, host, publisher, date and **tier**, plus structured claims `{entity, metric, value, unit, period, asOf, series, evidenceIds}` extracted per page by a small "read for a goal" call. Sources are tiered (regulators, statistics offices, standards bodies, manufacturers and primary documents above major press, above aggregators, above forums and marketplaces) with a per-language native preference list. Dedupe by canonical URL and article identity, reusing v2's identity functions. **Page text never enters a later prompt**: only quotes and claims leave the bank.
3. **Research rounds** (`researcher.ts`, `workspace.ts`, `rounds.ts`) — sub-questions fan out to isolated researcher calls at `ATLAS_V3_RESEARCHER_CONCURRENCY`. Each issues `ATLAS_V3_SEARCHES_PER_STEP` (3–5) searches through v2's `research_web` adapter with a **visible budget block** in the prompt, reads the top-tier pages for a stated goal, and returns a cleaned findings note. The round memo — `{answerSoFar, claims[], openQuestions[], deadEnds[], budgetUsed}` — is **rewritten** from the notes each round, never appended to.
4. **Living outline** (`outline.ts`) — sections are claims to defend, ordered by the reader's decision, each node listing the evidence it needs and the evidence ids it has. Rewritten after every round (expand, merge, cut). A node with thin evidence is trial-written and scored before it is committed. Two sections may not rest on the same evidence set — amended by the second evaluation to: two sections may not make the same argument from the same evidence.
5. **Goal test** (`goal.ts`) — stopping is a test, not a counter: the core question's claim table carries its key figures from **at least two independent publishers**, every outline node has at least `ATLAS_V3_MIN_EVIDENCE_PER_NODE` bound ids, and budget remains. Otherwise another round targets the named gaps, or the report **abstains** — a first-class outcome that renders as such rather than padding.
6. **Answer table** (`answer-table.ts`) — the structured answer the shape implies (comparison matrix, timeline, figure table), one evidence id per cell. Every delta, ratio and growth rate is computed through `run_python` from cited inputs; the model never does arithmetic.
7. **Writer** (`writer.ts`) — ONE writer, section by section, retrieve → think → write → prune. It sees the outline, the answer table, the text of the sections already written, and only its own section's evidence ids, which are dropped afterwards. It must synthesise across sources, adjudicate conflicts by naming the series or definition, date volatile figures inline, and may carry numbers computed in step 6. The executive summary is a **verdict** generated from the answer table plus the sections; an empty verdict **fails the job**.
8. **Critic** (`critic.ts`) — a whole-report pass against a failure taxonomy: no verdict in the first 150 words, a claim repeated across sections, a hollow sentence, an unsupported figure, a conflict averaged instead of adjudicated, a thin section, a missed implicit requirement, and register defects (Hungarian officialese, tautological openers, label-shaped titles). Each finding becomes an instruction — `rewrite`, `cut` or `needs_evidence(query)`. `needs_evidence` spends a small targeted research budget through the researcher and re-enters. Bounded by `ATLAS_V3_CRITIC_ROUNDS` (default 2, max 3).
9. **Verify and render** (`verify.ts`, `render.ts`) — v2's figure-level checks (`number-match.ts`) and `[[cite:n:c|s|i]]` annotations are kept, with a fourth outcome, `needs_evidence`, that re-enters the critic instead of deleting. Limitations say **what could not be established and why**, never how many sentences were cut. Tables and timelines render as first-class `documentSource` blocks with per-cell citations. `[n]` numbering is **mechanical**: the writer emits evidence ids only, and the bank assigns numbers at render.
10. **Exhaustive mode** runs three independent research passes and merges them at memo level before the outline is built.

### Per-task models

Each stage resolves its own model: `ATLAS_V3_ASK_MODEL`, `ATLAS_V3_RESEARCHER_MODEL`, `ATLAS_V3_OUTLINE_MODEL`, `ATLAS_V3_WRITER_MODEL`, `ATLAS_V3_CRITIC_MODEL`. Each accepts a model id or alias (`model1`, `model2`, `provider:<id>:<model>`) and falls back to `ATLAS_SYNTHESIS_MODEL` (writer-shaped tasks) or `ATLAS_AUDIT_MODEL` (control-shaped tasks). Resolution goes through the same `runAtlasModelStage` boundary, so pricing and provider failover are identical across stages.
<!-- ATLAS_V3_VERIFIER_MODEL was listed here but never used — no stage called deps.models.verifier — and was removed in Phase B of the v3-only consolidation (env, config-store, admin registry, settings UI, i18n, docs, .env.example) rather than wired up, since no entailment/verifier stage exists. -->

### Language standard

A per-language writer and critic addendum (`language-standard.ts`) carries register rules and native primary-source preferences — Hungarian KSH, Magyar Közlöny / njt.hu, ministries and MNB; Irish CSO, gov.ie, oireachtas; Dutch CBS and rijksoverheid — and the tiering uses the same list. `ATLAS_V3_LANGUAGE_STANDARD_HU` is on by default.

### Contract with the UI

`progress_details_json` keeps v2's shape with `pipelineVersion: 3`, so a client written against v2 degrades gracefully: `phase`, `plan` (outline nodes rendered as questions), `round`, `sourcesRead`, `next`, `evidence`, `phaseDurationsMs`, plus `qualityDiagnostics`. `queries` stays empty for the same reason it does on v2.

## Amendments (2026-09-10)

A ten-query staging evaluation on the local model found six defects, all
structural and all fixed mechanically — no new model call was added.

**Corroboration is a property of the fact, not of the citation.** One in-depth
run read 59 pages from 27 sources and produced `corroborated: 0, single: 53`.
Two causes. Claims merged only on an exact match of `entity|metric|period|series`,
so two readings of one measurement never met; claim identity is now normalised
(lowercased, punctuation stripped, stop words and naive plurals dropped) and a
**loose merge** joins two readings when entity and value match, unit, period and
series are compatible, no year named anywhere in the two identities disagrees,
and one metric's words are CONTAINED in the other's metric plus series. The
loose match only ever merges EQUAL values, and contested detection keeps the
strict identity, so it cannot invent a disagreement. Containment rather than
overlap, and the year check, are what keep `obligations start date` out of
`enforcement start date` and a 2024 figure out of its 2025 twin: where each side
carries a word the other has never heard of, they are two measurements. Second, sentence confidence counted publishers over the
ids the writer attached, and writers cite one quote per figure;
`atlasV3CorroboratingPublishersFor` now counts the publishers of the cited
quotes plus those of every quote on a NON-CONTESTED claim listing one of them —
two publishers on one side of a disagreement are one side of it, not a
corroboration. The writer and
the verdict are shown `alsoStatedBy` so a corroborated figure can be written as
one.

**A verdict that does not parse is not a dead job.** `writeAtlasV3Verdict` logs
what came back, retries once with the JSON shape restated, and the pipeline
falls back to a deterministic verdict assembled from the first load-bearing
sentence of each section (`verdictFallback: true` in the diagnostics, plus a
Limitations line). Only an empty fallback still throws.

**A verdict is coherent as a unit.** When verification cuts a verdict sentence,
the verdict is regenerated once with the cut text under `doNotState`; whatever
still opens with a reference back to a cut sentence is dropped.

**Abstention is now built, not only promised.** An outline that binds no
evidence falls back to the deterministic one, and a run that can write no
section produces an ABSTAINING report — a verdict saying so with what was spent,
one "what was searched" section listing the sub-questions and the strongest
sources read, and the sources rendered as `[n]`. `atlas_v3_no_sections` survives
only for a bank with no sources at all.

**Restatement and inference are capped mechanically.** The final verification
pass cuts a sentence whose cited ids and stated figures a kept sentence already
carried, and one resting only on quotes that already back three kept sentences
in the section when it adds no new figure (`repeated` in the totals). An
inferred sentence is capped at one per paragraph and a fifth of a section, and
may never open one. `minSentences` is capped at the node's bound evidence count
plus one, which is what stopped the writer padding a two-quote section.

**Headings are findings and the outline deduplicates.** Titles are cut at a word
boundary; a title over fourteen words is replaced by the claim's first clause;
the deterministic outline builds `Entity: metric value unit` from the
best-supported claim instead of `entity — metric`, and `isLabelShapedTitle`
rejects the old form — a spaced dash whose left side is at most three words, so
a finding that merely contains a dash is still a heading. After binding, nodes
whose title-plus-claim word sets overlap by half, or whose claim-id SETS are
half the same set, are merged, recorded as "merged into <title>". Nodes naming
different years never merge, and the merge does not run over the deterministic
outline, whose nodes are one per distinct `entity — metric` already.

## Amendments, second evaluation (2026-09-10)

The ten queries were re-run against the amendments above. Corroboration,
abstention and the verdict fallback held; **depth collapsed**. In-depth reports
came back at two or three sections and 276–1000 words against 1800–2800, and the
cause was the interaction between two of the fixes above.

**A section keeps every quote its claims carry.** Binding was EXCLUSIVE — a node
received only the quotes no earlier node had taken, and one whose quotes were
all taken was cut. That rule was written when a quote belonged to one claim;
once claims merged across sources, most quotes belonged to several, and the rule
starved every node after the first. A node now carries all the quotes behind its
claims, shared or not, best-supported claim first so the writer's
`maxEvidencePerSection` cap falls on the least corroborated, and its status is
computed from that full set. A node is
cut only when its whole evidence set is inside an earlier KEPT node's set **and**
the two nodes' title-plus-claim words overlap by a third: two sections arguing
different things from one teardown are two sections. Cross-section repetition
falls to the writer, which is shown the sections already written, to the critic's
`repeated_claim`, and to the verification pass's restatement cap.

**`minSentences` is two sentences per quote plus one, never below three.** The
"evidence count plus one" cap of the first amendment, over the one or two
exclusive quotes the binding left, is what wrote the two-sentence section.

**The section floor is enforced, not merely declared.** The profiles have
carried `minSections` from the start and nothing read it. The outline system
prompt now states the range and the claim count in words, and after binding, an
outline below the floor is topped up from the claims whose evidence NO node
bound, grouped by normalised entity and metric, best-supported group first,
titled as the deterministic outline titles its own nodes. A measurement a
section already argues is never topped up a second time: the deterministic
outline writes one section per entity and metric, and a second reading of one
of them is the duplicate section the merge exists to cut. The count reaches the
diagnostics as `sectionsSupplemented`.

**Series is a label, not a measurement.** The loose merge required period and
series to agree, and a bank of 164 claims kept most twins apart on exactly
those: one context window written `{period:"May 2026", series:"max context
length"}` by one publisher and `{period:"2026", series:"max context window"}` by
another. Periods now agree when one is the bare year the other names; series no
longer blocks a loose merge at all and keeps deciding CONTESTED through the
strict key; metrics agree by containment or by MORE than half their words —
strictly more, because `obligations start date` and `enforcement start date`
share exactly half; entities agree after parenthesised qualifiers and a trailing
model year are stripped, by equality, so `GPT-4.1 Mini` is still not `GPT-4.1`,
and the year guard reads the entity too so a stripped year can still refuse.
Stripping answers the qualifier ONE reader adds: where both wrote one and they
differ, `Renault (France)` stays apart from `Renault (Germany)`, and an entity
that normalises to nothing — `(EU)` against `(US)` — matches no one.
Loose merges are counted as `claimsMerged`.

**The evidence card carries what the report cited.** Each source's snippet is
built cited-quotes-first and capped at 4000 characters rather than 1200, because
the truncated tail made the evaluation report figures a cited quote does state
as unsupported. The critic loop's research round writes its own `research`
checkpoint, so the quotes it fetched survive for a post-mortem.

**Limitations say only what is true of the report as shipped.** A node merged
into another section is bookkeeping, kept in `outline.cut` and dropped from the
list; a THIN node — one that cites a quote — reads "rests on a single source",
and "no published source stated it" is reserved for a node with no evidence at
all; an unsupported table cell quotes its own text beside its row and column.

**The evaluation accepts a verdict that answers in words.** "An eight-week
statutory decision timeline … [1]" answers the question and cites what it rests
on; the digit-only rule scored it NO. A first-150-words sentence carrying a
citation and a number, spelled or written, now passes too.

## Amendments (2026-09-23) — Phase B of the v3-only consolidation

v1 and v2 stopped being frozen-but-runnable and were deleted outright, once evaluation showed v3 ahead
and no v1/v2 family remained worth keeping on its original pipeline:

- **`ATLAS_PIPELINE` is removed**, not just defaulted to `v3`. A switch with one legal value misleads an
  admin into thinking it still selects something; rollback is the `atlas-v1-v2-final` tag. `env.ts` logs
  one deprecation warning if the variable is still set in an operator's `.env`.
- **Every job runs v3**, including a Continue/Revise/Fork child of a v1/v2 family (D1 routing). The
  parent lookup on the send route still validates the parent succeeded and belongs to the same
  conversation, but no longer inherits or checks the parent's pipeline. `claimNextAtlasJob` restamps
  `pipelineVersion: 3` on every claim, so even a v1/v2 row already queued at deploy time runs fresh on
  v3 (it costs time, not correctness — `readAtlasV3ResumeState` ignores a foreign checkpoint schema).
  Until a later phase adds seeding, such a child runs unseeded rather than inheriting the parent's
  evidence.
- **v1/v2-only knobs are removed** alongside the pipelines that read them: the v2 profile
  questions/rounds, word and source ceilings, entailment batch, writer concurrency, and the v1 per-profile
  max-output-token caps and writer-prompt-char cap. `ATLAS_STALE_MONTHS` stays — it was miscategorized
  as v2-only in some docs, but the v3 pipeline reads it.
- **`ATLAS_V3_VERIFIER_MODEL` is removed**, not merely left dead. It resolved but nothing called it (see
  the per-task models note above); rather than invent a verifier/entailment stage to use it, the owner's
  call was to remove the key everywhere (env, config-store, admin registry, settings UI, i18n, docs,
  `.env.example`) and the `verifier` slot from `ATLAS_V3_MODEL_TASKS` with it, until such a stage is
  actually planned.
- **What still reads old rows.** Stored HTML/PDF/Markdown files, persisted `GeneratedDocumentSource`
  artifacts (including v1's `basisMarkers`/`confidenceMarker`), the job row's `1`/`2`/`3`
  `pipelineVersion` projection, the v1/v2 progress-detail sanitizers and client parsing, and the v1/v2
  checkpoint rows all keep working — this amendment deletes the CONTENT PIPELINES, not the read paths
  an already-published report depends on.

## Amendments (2026-09-24) — Phase C: the user's own documents as evidence

Stage 2's source definition ("url, title, host, publisher, date and tier") described web pages only.
Atlas Local Sources — the documents the user chose — are now evidence in the same bank:

- **Which documents.** The kickoff user message's explicit attachments and its snapshotted linked
  sources (and, from Phase D, the parent job's own local sources on Continue/Revise). Automatic
  working-set documents are deliberately NOT included: a citable evidence bank holds only material the
  user chose (ADR 0036 branch 6, as amended). Resolution runs at worker time through the knowledge
  boundary (`resolvePromptAttachmentArtifacts`, `getArtifactsForUser`), and every document must be
  canonically owned under the job conversation's STRICT ownership scope, so a linked source whose
  original chat has since gone incognito is refused.
- **Source shape.** `AtlasV3Source` is a union: a web source (`kind` absent or `web`) as before, or a
  local source `{kind: "local", tier: "user_document", publisher: "user-documents", host: "", date: null,
  displayArtifactId, promptArtifactId, origin}` whose `canonicalUrl` (`atlas-local:<id>`) is a dedupe key
  only and is never rendered.
- **One voice.** `user_document` is a tier that can corroborate, and every local source shares ONE
  publisher id. A figure from a user document plus one independent published source is `verified`; two
  user documents are one voice, so they are `single`. A local-only core claim is `single`, not `open`,
  so the report does not abstain because the only evidence is the user's.
- **Same verification.** Number-match, `verifyAtlasV3Report`, the critic's `unsupported_figure` check
  and the answer-table cell checks work on quotes and apply unchanged. A local `date` is null, so a user
  document is never stale-listed. `capAtlasV3Bank` never drops a local source and does not count it
  against `maxSources`.
- **The local read.** After the ask (which is told which documents exist) and before round one, each
  document is read ONCE: up to three passages for the core question and two per sub-question
  (`selectDocumentPassages`, 3,000 characters per call), deduped by chunk, at most 12,000 characters,
  joined by `---`, in one researcher-model call under `ATLAS_V3_READ_DOCUMENT_SYSTEM`. A **verbatim
  guard** (local reads only) files a quote only when it occurs inside one passage sent. The findings
  note is deterministic (no note call) and goes to round one's memo. At most 12 documents per job
  (`ATLAS_V3_MAX_LOCAL_SOURCES`); any beyond get a Limitations line, never silence.
- **Failure.** An explicit source that is unavailable at worker time (gone, out of scope, no text) fails
  the job with `atlas_v3_local_source_unavailable` (ADR 0036 edge case 5). An inherited one degrades to
  a Limitations line and a diagnostics count; so does a document whose read quoted nothing.
- **Prompts.** The ask, writer, verdict, memo and outline prompts each gained one line naming how the
  user's material is treated (answers questions about the user's situation; attributed as the user's
  document, never as a published statistic; one voice, not corroboration; a `fromUserDocument` claim may
  anchor a section about the user's own situation). The web read prompt is unchanged.
- **Render.** A cited local source is a library chip (`kind: "library"`, `url: null`, `provided: true`)
  in the SAME `sourceChips` block as the web chips, so `[n]` still points at the n-th chip; the renderers
  group it under "Your Library" without renumbering. The progress card carries `kind: "local"` with an
  empty host and draws a library glyph with "Your library".
- **Writer citations (fixed alongside).** The writer was told to cite `alsoStatedBy` ids but its parser
  accepted only the section's own ids and dropped the rest; it now accepts every id the prompt showed.
  The verdict now accepts only the ids its prompt showed (not any id in the bank).

## Amendments (2026-09-24) — Phase D: lifecycle children reuse the parent's evidence bank

Until Phase D a Continue, Revise or Fork child ran v3 from nothing (Phase B routed old families onto v3
unseeded). Now `atlas-v3/seed.ts` seeds it, and `atlas-v3/freshness.ts` decides what of the parent it
may trust:

- **What each action takes.** Continue: the parent's bank (rechecked with a 14-day window), its memo
  (claim ids filtered to claims that survived; its prose answer is not carried) and asked queries, and
  its outline as the first revision's `previous`. Revise: the bank (window 0) and the outline, NOT the
  memo — the parent's answer would anchor the rewrite. Fork: no bank, memo or outline; quotes are
  extracted for a goal, and reusing the parent's would bend the new direction back toward it and blur
  where the new family's citations came from. All three inherit the user's documents the parent read or
  was given (a Fork re-reads them for its own questions), re-resolved under the CHILD's strict scope.
- **Which parent.** Only a succeeded job of the same user in the same conversation seeds; anything else
  runs the child unseeded (the send route already refuses the kickoff; this is the worker-time check).
- **Persistence, no migration.** The verify checkpoint (round 24) now snapshots the capped bank the
  report was written from and the render checkpoint (25) the cited source ids; parents from before
  Phase D fall back to their latest research row and to the report's source chips. Every source records
  `retrievedAt`; a parent's source without one is dated by the parent's completion time.
- **The recheck.** A web source is time-sensitive when it carries a claim with no period and no date or
  one whose latest year is this year or last, or quotes with no claims from an aggregator or weak tier.
  Time-sensitive sources older than the window are re-read with `read(url, { fresh: true })`, which
  skips the 30-minute tool-result cache and asks Parallel Extract for `max_age_seconds: 600` (its
  minimum) with `disable_cache_fallback`, so a failed live fetch is reported rather than answered from
  an older cached copy. **Confirmed** (every quote still stated and every checkable figure still on the
  page): kept, restamped. **Changed**: unstated quotes and their claims dropped, the fresh page read once
  for the child's core question. **Unreachable**: dropped; its `entity metric period` hints join round
  one's questions (at most two). The budget is one research round's page reads
  (`pagesPerQuestion × subQuestionsPerRound`: 8, 15, 24), the parent's cited sources first, then by
  claim load; what it cannot reach is **dropped, never trusted** (ADR 0037 edge case 5, as amended).
  A user document that no longer resolves loses its quotes; one edited since it was read is re-read.
- **Old parents (D1).** A v1 or v2 parent — or a v3 one with no bank — seeds from its persisted
  `GeneratedDocumentSource`: title, level-2 headings, the verdict or executive summary with citation
  tokens stripped (at most 1,200 characters), and its web source-chip URLs (falling back to the
  checkpoint pool when no report persisted). The URLs are read now, within the same budget, for the
  child's core question; none of the parent's text is trusted unread. Its documents come from its
  kickoff message's links.
- **Resume.** The seeded bank is written as research round 0 (`{round: 0, bank, memo, asked, seed}`),
  so a retried child resumes it with round one still to run and never rechecks twice. Seeding runs only
  when the job has no research checkpoint of its own.
- **Prompts.** The ask prompt gains a `parent` block (action, title, core question, verdict, headings,
  date — a Fork sees only title and verdict) and an `instruction` that replaces the Revise-only
  `reviseInstruction`. Three ask-system lines, in English and Hungarian: the parent's verdict is
  orientation only, never evidence; a Continue extends the parent; a Revise replaces it and re-verifies
  its key figures and anything newer than its date. Nothing else changed: seeded quotes, claims and the
  outline reach the model through the fields that already carried them.
- **Cap.** At equal claim load, `capAtlasV3Bank` now keeps a source this job read over a seeded one, then
  the newer read (by day), before tier, so a Continue chain does not keep its oldest pages forever.
- **Diagnostics.** `qualityDiagnostics.seed` records the action, the parent's pipeline version, the
  sources and quotes seeded, and how many were trusted, rechecked, confirmed, changed, dropped and read
  as seed pages. `scripts/atlas-eval.ts --lifecycle continue|revise|fork` grades a child against it.

## Consequences

- Token cost per report is higher than v1 ever was (the critic and the answer table spend tokens on
  reasoning), since v1 no longer exists to compare against on a live deployment. Page reads remain the
  marginal cost and are capped by tier.
- Abstention becomes a **successful** job outcome. Anything that treats "succeeded" as "a full report" must read `abstained` in the diagnostics.
- Atlas runs one content pipeline. v1 and v2 were deleted in Phase B of the v3-only consolidation (see the amendment above); only v3 receives quality work, and only v3 exists to receive it.
- No model training, no long-context reliance, no parallel section writing, and no judge-based self-evaluation as a stopping rule on the local model — structural checks stop it instead.

## Alternatives rejected

- **Fixing v2's prompts.** The audit's six causes are all structural; a section written in one call from a snippet bag cannot reason whatever the prompt says.
- **A growing research transcript in the 262k window.** The literature is consistent that the rebuilt small workspace beats it at a fixed model, and Flash-Next gets no prefix-cache hits, so a long prompt costs full price every call.
- **Parallel section writers.** Faster, and reliably disjoint. One writer with the previous sections in view is what removes cross-section repetition.
