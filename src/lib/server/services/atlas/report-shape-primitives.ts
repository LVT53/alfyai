// Shared report-shape primitives used by BOTH `assembled-report.ts` (the report
// normalization/repair heuristics) and `report-shape-diagnostics.ts` (the shape
// diagnostics). Only byte-identical primitives live here. Deliberately NOT shared
// (they differ between the two modules and merging would change behavior):
//   - the markdown-strip / heading-normalize helpers (`stripMarkdownFormatting`
//     vs `stripMarkdown`, `normalizedReportShapeText` vs `normalizedHeading`)
//     have different bodies (image/URL/hyphen handling differs);
//   - `CLAIM_HEADING_VERB_PATTERN` — assembled-report's copy additionally matches
//     Hungarian claim verbs (`támogat|javít|nyújt|kínál|működik|teljesít`), the
//     diagnostics copy does not. Left divergent intentionally in this pass.

/**
 * Canonical section-heading labels (EN + HU, diacritic-stripped) that are
 * legitimate Atlas report headings — so they are never mistaken for a stray
 * sentence-claim heading or leaked prompt-instruction heading.
 */
export const SAFE_REPORT_HEADING_LABELS = new Set([
	"analysis",
	"deployment implications",
	"evidence gaps",
	"executive summary",
	"findings",
	"key findings",
	"latency and cost",
	"limitations",
	"model shortlist",
	"overview",
	"ranked shortlist",
	"recommendation",
	"recommendations",
	"recommended architecture",
	"retrieval quality",
	"sources",
	"summary",
	"tradeoffs",
	"trade offs",
	"vezetoi osszefoglalo",
	"osszefoglalo",
	"megallapitasok",
	"ajanlas",
	"ajanlasok",
	"korlatok",
	"kompromisszumok",
]);

/**
 * Imperative verbs / phrases that mark a heading as leaked prompt-instruction
 * text (e.g. "Answer …", "Use current web evidence …") rather than a real
 * report heading.
 */
export const PROMPT_INSTRUCTION_HEADING_PATTERN =
	/\b(?:answer|cite|compare|cover|explain|include|provide|return|use\s+current\s+web\s+evidence|with\s+current\s+web\s+evidence|write)\b/i;
