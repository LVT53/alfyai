// Pure scoring functions for the skill-instructions A/B evaluation harness.
//
// Everything in this module is a pure function with no I/O: no file access,
// no network calls, no environment reads. That is intentional — these are the
// unit-tested primitives that `evaluate-skill-instructions-ab.ts` composes
// with real model calls (which are NOT unit-tested here; only integration).

export type StructuralSignal = {
	signal: string;
	hit: boolean;
};

export type StructuralSignalOptions = {
	/** The user's original input text, used by signals that check preservation
	 * (e.g. Translate & Rewrite's placeholder-preservation check). */
	inputText?: string;
};

// --- Per-pack deterministic structural checks -----------------------------
//
// Each check targets the concrete artifact the corresponding Tier B upgrade
// (see the plan doc, "Tier B — per-pack content upgrades") asks the model to
// produce. Checks are intentionally conservative (regex/string based) so a
// "hit" is a reasonably strong signal, even though a "miss" does not prove
// the model failed the task (natural language is fuzzy).

const SEVERITY_TAG_RE = /\b(Blocker|Major|Minor)\b/;
const OVERALL_RISK_RE =
	/\b(overall risk|risk read)\b.{0,40}\b(Low|Medium|High)\b/i;

const MARKDOWN_TABLE_ROW_RE = /^\s*\|.*\|\s*$/m;
const BUY_WAIT_SKIP_RE = /\b(buy|wait|skip)\b/i;

const CONFIDENCE_TAG_RE =
	/\bconfidence\b|\bhigh\s*\/\s*medium\s*\/\s*low\b|\b(high|medium|low)[- ]confidence\b/i;

const ACTION_FIRST_OR_VERIFY_RE =
	/\b(verify|flag|confirm)\b.{0,20}\b(section|before|with|urgently)?|^(do first|lead with|priority|action[s]? first)/im;
const VERIFY_FLAG_KEYWORD_RE = /\b(verify|flag|confirm)\b/i;

const FLASHCARD_OR_SCHEDULE_RE =
	/\bflashcard|\bQ:\s|\bA:\s|\bcloze\b|\breview schedule\b|\bspaced repetition\b|\bstudy (plan|schedule)\b/i;

const SCENARIO_BREAKEVEN_RE =
	/\bscenario\b|\bbelow breakeven\b|\bbreakeven\b|\bwhat would change\b/i;

function hasMarkdownTable(text: string): boolean {
	// Require at least two "|"-delimited rows (header + one data/separator row)
	// to avoid false-positives on a single stray pipe character.
	const rows = text
		.split("\n")
		.filter((line) => MARKDOWN_TABLE_ROW_RE.test(line));
	return rows.length >= 2;
}

function extractPlaceholders(text: string): string[] {
	const braceMatches = text.match(/\{[^{}\s]+\}/g) ?? [];
	const angleMatches = text.match(/<[^<>\s]+>/g) ?? [];
	return [...braceMatches, ...angleMatches];
}

function placeholdersPreserved(
	inputText: string | undefined,
	output: string,
): boolean {
	if (!inputText) return true;
	const inputPlaceholders = extractPlaceholders(inputText);
	if (inputPlaceholders.length === 0) return true;
	return inputPlaceholders.every((placeholder) => output.includes(placeholder));
}

function signalsForPlanCritic(output: string): StructuralSignal[] {
	return [
		{ signal: "severity_tags", hit: SEVERITY_TAG_RE.test(output) },
		{ signal: "overall_risk_read", hit: OVERALL_RISK_RE.test(output) },
	];
}

function signalsForDocumentExplainer(output: string): StructuralSignal[] {
	return [{ signal: "confidence_tags", hit: CONFIDENCE_TAG_RE.test(output) }];
}

function signalsForStudyCoach(output: string): StructuralSignal[] {
	return [
		{
			signal: "flashcard_or_schedule",
			hit: FLASHCARD_OR_SCHEDULE_RE.test(output),
		},
	];
}

function signalsForPurchaseHelper(output: string): StructuralSignal[] {
	return [
		{ signal: "comparison_table", hit: hasMarkdownTable(output) },
		{ signal: "decisive_verdict", hit: BUY_WAIT_SKIP_RE.test(output) },
	];
}

function signalsForTranslateRewrite(
	output: string,
	options: StructuralSignalOptions | undefined,
): StructuralSignal[] {
	return [
		{
			signal: "placeholders_preserved",
			hit: placeholdersPreserved(options?.inputText, output),
		},
	];
}

function signalsForAppointmentPrep(output: string): StructuralSignal[] {
	return [
		{
			signal: "verify_flag_section",
			hit:
				ACTION_FIRST_OR_VERIFY_RE.test(output) ||
				VERIFY_FLAG_KEYWORD_RE.test(output),
		},
	];
}

function signalsForSpreadsheetBuilder(output: string): StructuralSignal[] {
	return [
		{ signal: "scenario_language", hit: SCENARIO_BREAKEVEN_RE.test(output) },
	];
}

/**
 * Per-pack deterministic structural checks: does the output contain the
 * artifact the corresponding instructions upgrade targets?
 *
 * Returns an empty array for unrecognized skill ids rather than throwing, so
 * the harness can safely call this for any pack id without a guard.
 */
export function structuralSignals(
	skillId: string,
	output: string,
	options?: StructuralSignalOptions,
): StructuralSignal[] {
	switch (skillId) {
		case "system:grill-with-docs":
			return signalsForPlanCritic(output);
		case "system:document-explainer":
			return signalsForDocumentExplainer(output);
		case "system:study-coach":
			return signalsForStudyCoach(output);
		case "system:purchase-helper":
			return signalsForPurchaseHelper(output);
		case "system:translate-rewrite":
			return signalsForTranslateRewrite(output, options);
		case "system:appointment-prep":
			return signalsForAppointmentPrep(output);
		case "system:spreadsheet-builder":
			return signalsForSpreadsheetBuilder(output);
		default:
			return [];
	}
}

export type ScoreDeltaResult = {
	beforeHits: number;
	afterHits: number;
	delta: number;
};

/**
 * Summarizes hit counts across a before/after pair of structural-signal
 * arrays and the delta (after - before). Positive delta means the AFTER
 * variant hit strictly more signals.
 */
export function scoreDelta(
	beforeSignals: StructuralSignal[],
	afterSignals: StructuralSignal[],
): ScoreDeltaResult {
	const beforeHits = beforeSignals.filter((s) => s.hit).length;
	const afterHits = afterSignals.filter((s) => s.hit).length;
	return { beforeHits, afterHits, delta: afterHits - beforeHits };
}

// --- LLM-as-judge, blind pairwise ------------------------------------------

/**
 * Builds a blind pairwise judge prompt. The two responses are labeled
 * "Response 1" / "Response 2" only — the caller is responsible for
 * randomizing which of (before, after) maps to which slot and recording the
 * mapping, so the judge model never sees which variant is which.
 */
export function buildJudgePrompt(
	response1: string,
	response2: string,
	rubricCriteria: string[],
): string {
	const criteriaList = rubricCriteria.map((c) => `- ${c}`).join("\n");
	const scoreShape = rubricCriteria
		.map((c) => `      "${c}": { "r1": <1-5>, "r2": <1-5> }`)
		.join(",\n");

	return [
		"You are a strict, impartial evaluator comparing two candidate responses to the same task.",
		"You do not know which response came from which system. Judge only what is in front of you.",
		"",
		"Rubric criteria (score each 1-5 for both responses, 5 = best):",
		criteriaList,
		"",
		"Response 1:",
		"<<<RESPONSE_1_START>>>",
		response1,
		"<<<RESPONSE_1_END>>>",
		"",
		"Response 2:",
		"<<<RESPONSE_2_START>>>",
		response2,
		"<<<RESPONSE_2_END>>>",
		"",
		'Decide an overall winner: 1 (Response 1 is better), 2 (Response 2 is better), or "tie" if they are materially equivalent.',
		"Respond with STRICT JSON only, no prose, no markdown fences, matching exactly this shape:",
		"{",
		'  "winner": 1 | 2 | "tie",',
		'  "scores": {',
		scoreShape,
		"  }",
		"}",
	].join("\n");
}

export type JudgeWinner = 1 | 2 | "tie";

export type JudgeResponse = {
	winner: JudgeWinner;
	scores: Record<string, { r1: number; r2: number }>;
};

function extractJsonCandidate(text: string): string | null {
	const trimmed = text.trim();
	// Try fenced code block first (```json ... ``` or ``` ... ```).
	const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenceMatch?.[1]) return fenceMatch[1].trim();

	// Fall back to the first "{" through the matching last "}".
	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
		return trimmed.slice(firstBrace, lastBrace + 1);
	}
	return null;
}

function isValidWinner(value: unknown): value is JudgeWinner {
	return value === 1 || value === 2 || value === "tie";
}

function isValidScores(
	value: unknown,
): value is Record<string, { r1: number; r2: number }> {
	if (typeof value !== "object" || value === null) return false;
	for (const entry of Object.values(value as Record<string, unknown>)) {
		if (typeof entry !== "object" || entry === null) return false;
		const { r1, r2 } = entry as Record<string, unknown>;
		if (typeof r1 !== "number" || Number.isNaN(r1)) return false;
		if (typeof r2 !== "number" || Number.isNaN(r2)) return false;
	}
	return true;
}

/**
 * Parses a judge model's raw text response into a structured result.
 * Returns null (never throws) when the text is not valid/well-formed JSON,
 * or when it is valid JSON but missing/malformed the expected fields, so
 * callers can treat a bad judge response as "no verdict" rather than crash
 * a batch run.
 */
export function parseJudgeResponse(text: string): JudgeResponse | null {
	const candidate = extractJsonCandidate(text);
	if (!candidate) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate);
	} catch {
		return null;
	}

	if (typeof parsed !== "object" || parsed === null) return null;
	const { winner, scores } = parsed as Record<string, unknown>;

	if (!isValidWinner(winner)) return null;
	if (!isValidScores(scores)) return null;

	return { winner, scores };
}
