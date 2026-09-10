# Atlas v3 reasons from an evidence bank, not from search excerpts

> Keeps [ADR-0036](0036-atlas-is-normal-chat-turn-not-parallel-subsystem.md) (Atlas is a Normal Chat Turn plus one in-process worker), [ADR-0052](0052-replace-searxng-web-research-with-parallel-search.md) (Parallel backend) and every piece of job infrastructure [ADR-0062](0062-atlas-content-pipeline-is-rebuilt-on-the-harness-tools.md) kept. It **replaces** ADR-0062's content pipeline for jobs stamped `pipeline_version: 3`. v1 and v2 stay runnable, unchanged.

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

Each stage resolves its own model: `ATLAS_V3_ASK_MODEL`, `ATLAS_V3_RESEARCHER_MODEL`, `ATLAS_V3_OUTLINE_MODEL`, `ATLAS_V3_WRITER_MODEL`, `ATLAS_V3_CRITIC_MODEL`, `ATLAS_V3_VERIFIER_MODEL`. Each accepts a model id or alias (`model1`, `model2`, `provider:<id>:<model>`) and falls back to `ATLAS_SYNTHESIS_MODEL` (writer-shaped tasks) or `ATLAS_AUDIT_MODEL` (control-shaped tasks). Resolution goes through the same `runAtlasModelStage` boundary v2 uses, so pricing and provider failover are identical.

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
claims, shared or not, and its status is computed from that full set. A node is
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
titled as the deterministic outline titles its own nodes. The count reaches the
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

## Consequences

- Token cost per report rises against v2 (the critic and the answer table spend tokens on reasoning) and stays far below v1. Page reads remain the marginal cost and are capped by tier.
- Abstention becomes a **successful** job outcome. Anything that treats "succeeded" as "a full report" must read `abstained` in the diagnostics.
- Three content pipelines now exist. v1 and v2 are frozen; only v3 receives quality work.
- No model training, no long-context reliance, no parallel section writing, and no judge-based self-evaluation as a stopping rule on the local model — structural checks stop it instead.

## Alternatives rejected

- **Fixing v2's prompts.** The audit's six causes are all structural; a section written in one call from a snippet bag cannot reason whatever the prompt says.
- **A growing research transcript in the 262k window.** The literature is consistent that the rebuilt small workspace beats it at a fixed model, and Flash-Next gets no prefix-cache hits, so a long prompt costs full price every call.
- **Parallel section writers.** Faster, and reliably disjoint. One writer with the previous sections in view is what removes cross-section repetition.
