# Atlas Fallback Boilerplate: Root Cause and Systematic Fix

**Purpose:** This document is a complete technical prompt for an implementing agent. It explains why Atlas reports keep coming out formulaic despite three rounds of fixes, and it specifies a concrete implementation that eliminates the root cause rather than patching symptoms.

**Status:** Ready for implementation

---

## 1. Problem Statement

Three live attempts (2026-06-22) each improved a different symptom but the report stayed formulaic and underdeveloped:

| Attempt | Fix applied | Result |
|---|---|---|
| 001 (9f5ab643) | Fixed malformed output detection | 566 body words, improvement didn't fire (94 w/section, threshold 75) |
| 002 (0fa568eb) | Added evidence-rich advisory | Improvement ran, but repeated generic boilerplate survived ("Use this as one decision input", "The rollout order should be set by...") |
| 003 (a73d47bb) | Removed the two exact repeated sentences | Same formulaic pattern under new wording ("decision criterion", "local validation step", query subject phrase appeared 5×). Improvement didn't run at all (726 words, no warnings) |

Each fix targeted a specific phrase or threshold. The underlying mechanism kept producing new variations of the same formulaic prose.

---

## 2. Root Cause

### 2.1 The deterministic fallback report generator

`src/lib/server/services/atlas/pipeline.ts` contains a function called `buildDeterministicFallbackReport`. It fires up to **3 times per pipeline run**:

1. **Pre-improvement fallback** — if the model's writer output is malformed (`needsAssemblyRepair` returns true after a repair attempt)
2. **Post-improvement fallback** — if the writer improvement pass output is still malformed
3. **Post-audit final quality gate fallback** — if `finalReportQualityFailures` finds shape problems after audit

Each invocation runs the same code path:

```
buildDeterministicFallbackReport
  → buildFallbackReportSections
    → fallbackTextForSection
      → developFallbackSectionText   ← hardcoded template sentences
      → fallbackValidationSentence   ← hardcoded validation templates
```

### 2.2 The template boilerplate generators

`developFallbackSectionText` (pipeline.ts, ~line 2209) is a large switch statement that injects hardcoded analysis sentences based on section title keywords. Examples:

- Recommendation section: `"For {querySubject}, start with the best-supported model family that meets the latency and hardware budget, keep a reranker-compatible fallback in the shortlist, and promote larger models only when corpus tests show a material retrieval gain."`
- Tradeoffs section: `"The practical tradeoff is to measure retrieval quality, embedding dimension, resident memory, reranking depth, and p95 latency together instead of optimizing one benchmark score in isolation."`
- Findings section: `"For {querySubject}, the findings should be ranked by decision impact: which signal improves answer quality, which keeps serving risk acceptable, and which uncertainty must be tested locally."`
- Default fallback: `"For {querySubject}, the {section} evidence should become an explicit decision criterion, a local validation step, and a condition that would change the recommendation."`

`fallbackValidationSentence` (pipeline.ts, ~line 2156) adds a second template sentence per section:

- Recommendation: `"Turn the recommendation into a rollout rule only after the local corpus test shows a material gain within the latency, memory, and review budget."`
- Tradeoffs: `"Use the tradeoff section to set the operating budget first, then spend extra model size or reranking depth only where measured retrieval quality improves."`
- Default: `"For the {section} decision, define the local validation step and the evidence threshold that would change the recommendation."`

These are the exact phrases that appeared in attempts 002 and 003. They are not model output. They are **code-generated template strings**.

### 2.3 Why diagnostics cannot catch the problem

`report-shape-diagnostics.ts` measures:

- body word count
- source word count and share
- section count
- substantive section count (sections with ≥55 words or structured content)
- one-sentence section count
- claim-shaped heading count
- image count
- decision/recommendation signal presence

None of these can distinguish:
- genuine evidence-grounded analysis from template sentences that happen to exceed word thresholds
- a real recommendation from `"For {querySubject}, start with the best-supported model family..."`
- a real findings section from `"For {querySubject}, the findings should be ranked by decision impact..."`

A 726-word fallback report with 9 sections passes all diagnostics (attempt 003). The template sentences are long enough, the sections are numerous enough, and the decision-signal regex matches "recommend" in the template text.

### 2.4 Why each fix only moves the formula

`developFallbackSectionText` has ~10 section-type branches. `fallbackValidationSentence` has ~7 branches. Removing one phrase (attempt 002 → 003) just means a different branch fires with different wording. The structure — template analysis sentence + template validation sentence + query subject injection — stays identical. The report reads as formulaic because it **is** formulaic by construction.

### 2.5 Why the improvement pass preserves the scaffolding

When `shouldImproveAtlasWriterDraft` triggers (attempt 002), the improvement prompt includes `currentDraft: finalAssembledMarkdown`. If the fallback already replaced the model's draft, the model is told to "rewrite" a template-generated report. The model tends to preserve structure and rephrase rather than discard everything and start fresh — so the formulaic pattern survives in new wording.

### 2.6 The final quality gate can override good model output

After audit, `finalReportQualityFailures` checks source share, section shallowness, and body word count. If any fail, it **replaces the model's audited report** with `buildDeterministicFallbackReport`. This can override thin-but-honest model output with template boilerplate that looks structurally better but is less truthful.

---

## 3. The Fix

### 3.1 Principle

**A deterministic code function cannot write a decision-quality report. Stop using it as a writer. Use it only as an honest evidence listing when the model completely fails.**

The fallback must:
- look like what it is (evidence that Atlas gathered but could not synthesize)
- not look like a report (no fake analysis, no fake recommendations, no fake tradeoffs)
- be honest about why it exists (model could not produce a usable report)

### 3.2 Replace `buildDeterministicFallbackReport` with `buildHonestEvidenceFallbackReport`

Delete the following functions entirely from `pipeline.ts`:

- `developFallbackSectionText`
- `fallbackValidationSentence`
- `fallbackTextForSection` (the statement-matching + template-injection function)
- `fallbackQueryNounPhrase`
- `fallbackSectionReference`
- `fallbackSentenceCount`
- `buildFallbackReportSections` (the section assembly that calls the above)

Replace `buildDeterministicFallbackReport` with a new function:

```typescript
function buildHonestEvidenceFallbackReport(input: {
  language: SupportedLanguage;
  query: string;
  evidencePacks: AtlasEvidencePack[];
  searchLimitation: { code: string; message: string } | null;
  currentDate: string;
}): { markdown: string; metadata: AtlasAssemblyMetadata }
```

This function produces a minimal, honest artifact:

**Title:** Query-derived title (reuse `normalizeFallbackTitle` — keep this function).

**Executive Summary:** One sentence stating Atlas gathered N sources but could not synthesize a decision-quality report. The user should review the evidence below or retry with a more specific query.

**Evidence Summary section:** List each evidence pack's `evidence.summary` as a bullet point, grouped by authority if practical. No template sentences. No analysis. Just what was found.

**Limitations section:** State that the model's synthesis attempt did not produce a usable report, so Atlas is shipping the raw evidence summary instead. Include any search limitation message. Include a note that the user can retry with Continue/Revise for a fresh synthesis attempt.

**No other sections.** No Findings, no Tradeoffs, no Recommendation, no Deployment Implications. Those sections require analysis, and the fallback cannot analyze.

Example output shape (English):

```markdown
# Self-hosted embedding models for English technical-document retrieval in 2026

## Executive Summary

Atlas gathered 16 accepted sources for this query but could not synthesize them into a decision-quality report. The evidence summaries below are available for review. You can retry with Continue or Revise for a fresh synthesis attempt.

## Evidence Summary

- **E5-Mistral-7B** (benchmark): Achieves strong MTEB scores for English retrieval; 7B parameters require multi-GPU or quantized serving. (Source: MTEB leaderboard)
- **BGE-M3** (vendor): Multilingual model with good English performance; supports dense, sparse, and ColBERT modes. (Source: BAAI blog)
- ... (one bullet per evidence pack, using pack.evidence.summary directly)

## Limitations

- Atlas could not produce a decision-quality synthesis from the accepted evidence. The model's output was not usable as a published report.
- The evidence above is raw and unranked. No recommendation, tradeoff analysis, or deployment guidance was generated.
- Retry with Continue or Revise to attempt a fresh synthesis with the same evidence base.
```

**Hungarian equivalent** for `language === "hu"` — same structure, localized strings.

### 3.3 Change the pipeline fallback trigger points

#### 3.3.1 Pre-improvement fallback (line ~2870)

Current: if model output is malformed after repair, replace with `buildDeterministicFallbackReport`.

New: if model output is malformed after repair, replace with `buildHonestEvidenceFallbackReport`. Set `usedDeterministicFallbackBeforeImprovement = true` (keep this flag).

**But also:** if the model output is NOT malformed (passes `needsAssemblyRepair`), do not run the fallback at all. Let thin-but-honest model output proceed to diagnostics. The diagnostics may trigger the improvement pass, which is the correct path for thin output.

#### 3.3.2 Post-improvement fallback (line ~2937)

Current: if improvement pass output is malformed, replace with `buildDeterministicFallbackReport`.

New: if improvement pass output is malformed, replace with `buildHonestEvidenceFallbackReport`. Do NOT run another repair attempt. Ship the honest fallback.

#### 3.3.3 Post-audit final quality gate fallback (line ~3094)

Current: if `finalReportQualityFailures` finds issues, replace the model's audited report with `buildDeterministicFallbackReport`.

New: **Remove this fallback entirely.** Do not replace the model's audited report. Instead:

1. If `finalReportQualityFailures` finds issues, append an honest Limitations paragraph to the existing audited markdown:

```
## Additional Limitations

Atlas report-shape diagnostics indicate that this report may be too thin, too source-dominated, or too shallow in some sections. The synthesis above represents the model's best effort given the accepted evidence. Review the evidence and retry with Continue or Revise if deeper analysis is needed.
```

2. Record the diagnostics in the checkpoint (already happens).
3. Do NOT mark the job as failed unless there is a critical audit finding (already handled by `hasCriticalAuditFinding`).

**Rationale:** A thin model report is more honest than a template-generated fake report. The user sees what the model actually wrote, plus an honest note that it may be thin. This is better than masking model failure with boilerplate that looks substantive.

### 3.4 Remove the final hard-stop fallback path

The current code at line ~3166 has `shouldHardStopAfterFinalFallback` which can add a critical marker if the fallback is still bad. Since we removed the final fallback, this path no longer applies. Remove:

- `FINAL_REPORT_HARD_STOP_CODES`
- `shouldHardStopAfterFinalFallback`
- The `if (shouldHardStopAfterFinalFallback(afterFailures))` block

Keep `FINAL_REPORT_GATE_WARNING_CODES` and `finalReportQualityFailures` — they still produce diagnostics for the checkpoint. But their output no longer triggers a fallback replacement.

### 3.5 Keep the writer improvement pass, but fix what it receives

The improvement pass (`shouldImproveAtlasWriterDraft` → `buildAtlasWriterImprovementPrompt`) should still run when diagnostics indicate a thin draft. But:

- If the draft is the honest evidence fallback (not a model draft), **do not run the improvement pass**. There's nothing to improve — the fallback is intentionally minimal. Instead, skip straight to audit.
- If the draft is a model draft (even a thin one), run the improvement pass as before. The model should get a chance to rewrite its own work.

Add a check:

```typescript
if (
  usedDeterministicFallbackBeforeImprovement &&
  shouldImproveAtlasWriterDraft(firstDraftReportShapeDiagnostics)
) {
  // Skip improvement pass — the fallback is intentionally minimal.
  // Record the skip in writerImprovement diagnostics.
  writerImprovement = {
    ran: false,
    passCount: 0,
    reasonWarningCodes: firstDraftReportShapeDiagnostics.warnings.map(w => w.code),
    startedAfterDeterministicFallback: true,
    skippedReason: "honest_fallback_does_not_need_improvement",
  };
} else if (shouldImproveAtlasWriterDraft(firstDraftReportShapeDiagnostics)) {
  // ... existing improvement pass logic ...
}
```

### 3.6 Keep `sanitizeMalformedWriterHeadings` but only for model output

`sanitizeMalformedWriterHeadings` is still useful for cleaning up model-generated headings. But it should NOT run on the honest evidence fallback — the fallback's headings are already clean by construction.

Add a guard: only run `sanitizeMalformedWriterHeadings` when the current markdown is NOT from the honest fallback.

### 3.7 Keep evidence-pack statement extraction for the honest fallback

The honest fallback needs evidence pack summaries. These already exist in `AtlasEvidencePack.evidence.summary`. The fallback should use them directly.

If `evidence.summary` is empty or low-quality for a pack, skip that pack in the listing rather than generating a template sentence. The existing `isLowQualityFallbackText` and `isProcessFallbackStatement` filters can be reused to skip bad summaries.

### 3.8 Source projection stays unchanged

The deterministic source projection (`buildPublishedAtlasSources`, `compactAtlasSourceRelevanceNote`, `buildAtlasDocumentSource`) remains app-owned and unchanged. The honest fallback still feeds into `buildAtlasDocumentSource` for rendering — it just has fewer body blocks and no fake analysis.

---

## 4. Files to Change

| File | Change |
|---|---|
| `src/lib/server/services/atlas/pipeline.ts` | Delete `developFallbackSectionText`, `fallbackValidationSentence`, `fallbackTextForSection`, `fallbackQueryNounPhrase`, `fallbackSectionReference`, `fallbackSentenceCount`, `buildFallbackReportSections`. Replace `buildDeterministicFallbackReport` with `buildHonestEvidenceFallbackReport`. Remove post-audit final quality gate fallback. Remove hard-stop codes. Add improvement-skip for honest fallback. Guard `sanitizeMalformedWriterHeadings` against honest fallback. |
| `src/lib/server/services/atlas/pipeline.test.ts` | Update tests: fallback produces evidence listing, not template report. No fake analysis sentences. No fake recommendations. Honest limitations text. Improvement pass skipped for honest fallback. Post-audit does not replace model output. |
| `src/lib/server/services/atlas/output.test.ts` | Update output tests for the new fallback shape. |
| `src/lib/server/services/atlas/report-shape-diagnostics.ts` | No changes needed — diagnostics stay the same. They just trigger different downstream behavior. |
| `src/lib/server/services/atlas/writer.ts` | No changes needed — writer prompt and improvement prompt stay the same. |

### Functions to KEEP (still used):

- `normalizeFallbackTitle` — query-derived title extraction
- `extractFallbackOutlineTitles` — may still be useful for the honest fallback's evidence grouping, but only if evidence packs have section hints. If not, drop it.
- `fallbackSectionLabels` — keep for the honest fallback's Executive Summary and Limitations section titles
- `cleanFallbackStageText`, `cleanFallbackScalar` — keep for cleaning evidence pack summaries
- `isLowQualityFallbackText`, `isProcessFallbackStatement` — keep for filtering bad evidence summaries
- `ensureTerminalPunctuation` — keep
- `fallbackStatementsFromEvidencePacks` — keep, but only for extracting clean evidence pack summaries for the listing
- `fallbackStatementsFromStageText` — DELETE (no longer extracting from synthesis/curated evidence for template injection)
- `stripFallbackSectionPrefix` — DELETE (no longer needed)
- `statementMatchesSectionTitle` — DELETE (no longer matching statements to sections)
- `sectionTitleTokenSet` — DELETE
- `uniqueFallbackSectionTitles` — DELETE (honest fallback has fixed sections: Executive Summary, Evidence Summary, Limitations)
- `isCleanCustomFallbackSectionTitle` — DELETE
- `canonicalFallbackSectionTitle` — DELETE
- `buildFallbackSectionBriefsFromSections` — simplify: honest fallback has 3 fixed sections with all evidence pack IDs attached
- `buildFallbackGeneratedTitle` — keep but simplify (just `normalizeFallbackTitle`)

### Functions to DELETE entirely:

- `developFallbackSectionText` — the main template boilerplate generator
- `fallbackValidationSentence` — the validation template generator
- `fallbackTextForSection` — the statement-matching + template injection dispatcher
- `fallbackQueryNounPhrase` — query subject extraction for template injection
- `fallbackSectionReference` — section name extraction for template injection
- `fallbackSentenceCount` — sentence counting for template expansion control
- `buildFallbackReportSections` — section assembly that calls all the above
- `fallbackLimitationsText` — replace with inline limitations text in the honest fallback
- `combineResearchRoundLimitations` — keep (still used for search limitation aggregation, not fallback-specific)
- `FINAL_REPORT_HARD_STOP_CODES` — delete
- `shouldHardStopAfterFinalFallback` — delete

---

## 5. What NOT to Do

1. **Do NOT add more diagnostic thresholds.** The problem is not that diagnostics are too permissive. The problem is that the fallback generates prose that passes diagnostics without being real analysis.

2. **Do NOT add phrase-specific removal.** Removing "decision criterion" or "local validation step" from templates just means another branch fires with different wording. Delete the entire template system.

3. **Do NOT make the fallback smarter.** The fallback should be dumber, not smarter. It should list evidence honestly and say "Atlas could not synthesize this." Any attempt to make it generate analysis will reproduce the formulaic problem.

4. **Do NOT add more model retry loops.** The pipeline already has: repair → improvement → audit retry. That's 3 model passes. Adding more violates ADR 0037's bounded architecture. The honest fallback is the bounded exit.

5. **Do NOT change the writer prompt or improvement prompt.** The model-facing contracts are fine. The problem is downstream of the model — the fallback overwrites model output.

6. **Do NOT remove the diagnostics or the improvement pass.** They are correct for thin model output. The fix is to stop replacing model output with template prose, not to stop detecting thin output.

7. **Do NOT make the honest fallback look like a report.** It should look like what it is: an evidence listing with a "could not synthesize" notice. If it looks like a report, users will judge it as a bad report. If it looks like raw evidence, users will judge it as honest degradation.

8. **Do NOT keep any template analysis sentences "just in case."** Every template sentence is a future boilerplate sighting. Delete all of them. If the model can't write the analysis, ship the evidence without analysis.

---

## 6. Implementation Order

1. Write `buildHonestEvidenceFallbackReport` as a new function.
2. Write tests for it: produces evidence listing, no template sentences, honest limitations, works with empty evidence packs.
3. Replace all 3 call sites of `buildDeterministicFallbackReport` with `buildHonestEvidenceFallbackReport`.
4. Remove the post-audit final quality gate fallback (call site #3) entirely — replace with limitations append.
5. Add the improvement-skip guard for honest fallback.
6. Add the `sanitizeMalformedWriterHeadings` guard for honest fallback.
7. Delete all template boilerplate functions listed in section 4.
8. Update pipeline tests for the new behavior.
9. Update output tests for the new fallback shape.
10. Run `npm run check`, `npm test`, `npm run build`.
11. Verify no template phrases survive: grep for "decision criterion", "local validation step", "condition that would change the recommendation", "rollout rule", "operating budget first", "measured pilot for" in the Atlas service directory — expect zero hits outside test fixtures.

---

## 7. Verification Criteria

### 7.1 Unit tests

- [ ] `buildHonestEvidenceFallbackReport` produces markdown with exactly 3 sections: Executive Summary, Evidence Summary, Limitations.
- [ ] No section contains template analysis sentences (no "For {subject}, start with...", no "The practical tradeoff is to measure...", no "Turn the recommendation into a rollout rule...").
- [ ] Evidence Summary lists one bullet per evidence pack with a non-empty summary, filtered by `isLowQualityFallbackText`.
- [ ] Limitations section states the model could not synthesize and the user can retry.
- [ ] Empty evidence packs produce a report that still has 3 sections and says no evidence was available.
- [ ] Hungarian language produces Hungarian section titles and limitations text.

### 7.2 Pipeline tests

- [ ] When model writer output is malformed after repair, the honest fallback is used (not the old template fallback).
- [ ] When the honest fallback is active, the writer improvement pass is skipped.
- [ ] When the writer improvement pass produces malformed output, the honest fallback is used.
- [ ] After audit, if `finalReportQualityFailures` finds issues, the model's audited report is NOT replaced. A limitations paragraph is appended instead.
- [ ] `shouldHardStopAfterFinalFallback` no longer exists or is never called.
- [ ] `sanitizeMalformedWriterHeadings` does not run on honest fallback output.

### 7.3 Grep verification

```bash
# These phrases should NOT appear in any Atlas source file (only in test fixtures if any):
grep -rn "decision criterion\|local validation step\|condition that would change the recommendation\|rollout rule only after\|operating budget first\|measured pilot for\|best-supported model family\|ranked by decision impact" src/lib/server/services/atlas/
# Expect: zero hits outside *.test.ts fixtures
```

### 7.4 Structural gates

- [ ] `npm run check` passes with 0 errors and 0 warnings
- [ ] `npm test` passes
- [ ] `npm run build` passes with 0 warnings
- [ ] `npm run lint` passes

### 7.5 ADR compliance

- ADR 0036: Atlas is still a Normal Chat Turn + artifact. No new tables, no parallel subsystem. ✓
- ADR 0037: Bounded architecture preserved. No new loops. The honest fallback is a terminal exit, not a retry. Improvement pass is still bounded to 1. ✓
- ADR 0038: Writer-centered reports. The fallback is no longer pretending to be a writer — it's an honest evidence listing. This is more aligned with ADR 0038 than the old template generator. ✓

---

## 8. Why This Breaks the Cycle

The cycle was:

```
Model writes thin/malformed report
  → Fallback replaces it with template prose
  → Diagnostics pass (template prose is long enough)
  → Report ships looking formulaic
  → Agent removes specific phrase
  → Different template branch fires
  → Same formulaic pattern under new wording
  → Repeat
```

The fix breaks the cycle at the first arrow:

```
Model writes thin/malformed report
  → Honest fallback ships evidence listing + "could not synthesize"
  → Report ships looking like raw evidence (not a fake report)
  → User sees honest degradation and can retry
  → No template prose to chase
```

And for the case where the model writes a thin-but-honest report:

```
Model writes thin report (not malformed)
  → Diagnostics detect thinness
  → Improvement pass runs (model rewrites its own work)
  → If still thin, ship with appended limitations
  → No fallback replacement at all
```

The key insight: **the diagnostics and improvement pass are fine for model output. The problem was always the fallback replacing model output with template prose. Remove the replacement, and the cycle stops.**

---

## 9. Context for the Implementing Agent

You are implementing a fix for the Atlas report pipeline in the AlfyAI codebase. The codebase uses SvelteKit, Svelte 5, TypeScript, Vitest, and Drizzle ORM. Atlas is a durable research report artifact produced by a background job with a server-owned multi-stage pipeline.

Before touching code:
- Read `AGENTS.md` for boundary rules.
- Read `docs/adr/0036-atlas-is-normal-chat-turn-not-parallel-subsystem.md`, `docs/adr/0037-atlas-uses-bounded-adaptive-rounds-not-autonomous-research-loops.md`, and `docs/adr/0038-atlas-publishes-writer-centered-reports-not-source-dumps.md`.
- Read `src/lib/server/services/atlas/pipeline.ts` in full, especially lines 1630–2600 (the fallback system) and lines 2800–3200 (the pipeline flow that calls the fallback).
- Read `src/lib/server/services/atlas/report-shape-diagnostics.ts` to understand what diagnostics exist.
- Read `src/lib/server/services/atlas/writer.ts` to understand the writer prompt contract.

Constraints:
- Do not add new database tables.
- Do not change the writer prompt or improvement prompt.
- Do not add new model retry loops.
- Do not change the file-production output contract.
- Do not change route entrypoints.
- Use TDD: write tests for `buildHonestEvidenceFallbackReport` before deleting the old functions.
- Run `npm run check` and `npm test` after every meaningful change.
- Match existing code style (TypeScript, no `as any`, no `@ts-ignore`).
- Delete dead code after replacement. Do not leave commented-out functions.
