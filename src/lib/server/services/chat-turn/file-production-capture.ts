// Decide whether text the model emitted around a file-production tool call
// is leaked machinery (document JSON, tool-call fragments, "fixing the JSON"
// narration) that belongs in the hidden reasoning lane, or ordinary answer
// text that must stay visible.
//
// The stream orchestrator used to divert EVERY text delta between a
// produce_file call and its result (plus a trailing window) into the thinking
// lane. That hid real content: a model that starts its answer, calls
// produce_file mid-way, and continues the answer lost the part written while
// the call was in flight. Now the text is buffered and classified when the
// window closes.

const JSON_KEY_RE =
	/"(?:documentSource|blocks|requestTitle|outputType|filename|requestedOutputs|sourceMode|program|patches|markdown|content|text)"\s*:/;
const REPAIR_NARRATION_RE =
	/^\s*(?:i(?:'ll| will| am going to| need to| should)?|let me)\s+(?:fix|repair|correct|adjust|rewrite|reformat|retry)\b[^.!?\n]{0,200}\b(?:json|document[_\s-]+source|schema|formatting|call|tool)\b/i;

export function looksLikeFileProductionLeak(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return true;
	if (/^[[{]/.test(trimmed)) return true;
	if (/^```(?:json)?\s*\n?\s*[[{]/i.test(trimmed)) return true;
	if (JSON_KEY_RE.test(trimmed)) return true;
	if (REPAIR_NARRATION_RE.test(trimmed)) return true;
	// Mostly punctuation/brace soup with no prose words.
	const words = trimmed.match(/[\p{L}]{3,}/gu)?.length ?? 0;
	const braces = (trimmed.match(/[{}[\]"]/g) ?? []).length;
	return words < 3 && braces >= 4;
}

export type FileProductionCapture = {
	active: boolean;
	postWindowChars: number;
	buffer: string;
};

export function createFileProductionCapture(): FileProductionCapture {
	return { active: false, postWindowChars: 0, buffer: "" };
}
