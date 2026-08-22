// Lenient JSON recovery for model-emitted config blocks (e.g. a ```chart body).
// Local models frequently emit JSON that is one closing brace short or carries a
// trailing comma — the classic truncation/over-generation failure. `parseJsonLenient`
// tries a strict parse first and only falls back to a best-effort repair, so a
// well-formed body is never touched. The repair is deliberately conservative: it
// balances open brackets and strips trailing commas WITHOUT rewriting values, so
// it can only ever turn "not quite valid" into "valid" or leave it unparseable
// (in which case the caller keeps its existing fallback).

/**
 * Repair the two dominant LLM JSON defects — a trailing comma before a closer,
 * and unclosed `{`/`[` at end-of-input — while tracking string/escape state so
 * braces, brackets, and commas inside string values are never disturbed.
 * Returns a best-effort string; it is NOT guaranteed to be valid JSON.
 */
export function repairJson(raw: string): string {
	const stack: ("}" | "]")[] = [];
	let inString = false;
	let escaped = false;
	let out = "";

	for (let i = 0; i < raw.length; i += 1) {
		const ch = raw[i];

		if (inString) {
			out += ch;
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}

		if (ch === '"') {
			inString = true;
			out += ch;
			continue;
		}

		if (ch === "{") {
			stack.push("}");
			out += ch;
			continue;
		}
		if (ch === "[") {
			stack.push("]");
			out += ch;
			continue;
		}

		if (ch === "}" || ch === "]") {
			// A trailing comma immediately before a closer is invalid JSON; drop it.
			out = out.replace(/,\s*$/, "");
			if (stack.length > 0 && stack[stack.length - 1] === ch) stack.pop();
			out += ch;
			continue;
		}

		out += ch;
	}

	// Trailing comma at EOF (e.g. a truncated array), then close anything still open
	// — innermost first, which is the order the stack pops.
	out = out.replace(/,\s*$/, "");
	while (stack.length > 0) {
		out += stack.pop();
	}
	return out;
}

/**
 * Parse `raw` as JSON, tolerating the common truncation/trailing-comma defects.
 * A strict parse is attempted first (a valid body is returned unchanged); only on
 * failure is the repaired form parsed. Returns `undefined` when neither parses.
 */
export function parseJsonLenient(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		// fall through to the repair attempt
	}
	try {
		return JSON.parse(repairJson(raw));
	} catch {
		return undefined;
	}
}
