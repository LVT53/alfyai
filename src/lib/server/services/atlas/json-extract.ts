/**
 * Repairs a writer answer the model never finished.
 *
 * A `finishReason: "length"` body is valid JSON up to the point the cap cut it
 * and rubble after: half a key, half a string, an unclosed array. This walks
 * the text once, remembers the last position at which a NESTED value closed
 * cleanly — the end of a complete sentence object, of a `citations` array — and
 * rebuilds the document from that prefix plus the closers the open stack still
 * needs. Everything after the cut point is discarded, so a half-written
 * sentence is never published as a whole one.
 *
 * Returns null when nothing closed cleanly, and returns the object as-is when
 * the text was complete after all.
 *
 * Copied from atlas-v2's `salvageTruncatedWriterJson` (`atlas-v2/writer.ts`),
 * which keeps its own copy; this one is the shared home other Atlas pipeline
 * stages should use instead of reaching into v2 for it.
 */
export function salvageTruncatedJson(text: string): string | null {
	const start = text.indexOf("{");
	if (start < 0) return null;
	const body = text.slice(start);
	const stack: Array<"{" | "["> = [];
	let inString = false;
	let escaped = false;
	let safeCut = -1;
	let safeStack: Array<"{" | "["> = [];
	for (let index = 0; index < body.length; index += 1) {
		const character = body[index];
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (character === "\\") {
				escaped = true;
				continue;
			}
			if (character === '"') inString = false;
			continue;
		}
		if (character === '"') {
			inString = true;
			continue;
		}
		if (character === "{" || character === "[") {
			stack.push(character);
			continue;
		}
		if (character !== "}" && character !== "]") continue;
		stack.pop();
		// The root object closed: the answer was complete, cap or no cap.
		if (stack.length === 0) return body.slice(0, index + 1);
		safeCut = index + 1;
		safeStack = [...stack];
	}
	if (safeCut < 0) return null;
	const closers = [...safeStack]
		.reverse()
		.map((opener) => (opener === "{" ? "}" : "]"))
		.join("");
	return `${body.slice(0, safeCut)}${closers}`;
}

export function parseJsonFromText(text: string): unknown | null {
	for (const candidate of jsonCandidates(text)) {
		const result = tryParseVariants(candidate);
		if (result !== null) return result;
	}
	return null;
}

function jsonCandidates(text: string): string[] {
	const trimmed = text.trim();
	if (!trimmed) return [];

	const candidates: string[] = [];
	const seen = new Set<string>();

	function addCandidate(candidate: string): void {
		const normalized = candidate.trim();
		if (!normalized || seen.has(normalized)) return;
		seen.add(normalized);
		candidates.push(normalized);
	}

	addCandidate(trimmed);

	for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
		const fenced = match[1]?.trim();
		if (fenced) addCandidate(fenced);
	}

	const balanced = balancedJsonCandidates(trimmed);
	balanced.sort((a, b) => b.length - a.length);
	for (const candidate of balanced) {
		addCandidate(candidate);
	}

	return candidates;
}

function tryParseVariants(text: string): unknown | null {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		// fall through
	}

	const noCommas = removeTrailingCommas(text);
	if (noCommas !== text) {
		try {
			return JSON.parse(noCommas) as unknown;
		} catch {
			// fall through
		}
	}

	const doubleQuoted = replaceSingleQuotes(text);
	if (doubleQuoted !== text && doubleQuoted !== noCommas) {
		try {
			return JSON.parse(doubleQuoted) as unknown;
		} catch {
			// fall through
		}
	}

	if (noCommas !== text && doubleQuoted !== text) {
		const both = replaceSingleQuotes(noCommas);
		if (both !== noCommas && both !== doubleQuoted) {
			try {
				return JSON.parse(both) as unknown;
			} catch {
				// fall through
			}
		}
	}

	return null;
}

function removeTrailingCommas(text: string): string {
	let result = "";
	let inString = false;
	let escaped = false;

	for (let i = 0; i < text.length; i++) {
		const char = text[i];

		if (inString) {
			result += char;
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			result += char;
			inString = true;
			continue;
		}

		if (char === ",") {
			const after = text.slice(i + 1).trimStart();
			if (
				after.startsWith("}") ||
				after.startsWith("]") ||
				after.startsWith(",")
			) {
				continue;
			}
		}

		result += char;
	}

	return result;
}

function replaceSingleQuotes(text: string): string {
	let result = "";
	let inDoubleString = false;
	let inSingleString = false;
	let escaped = false;

	for (const char of text) {
		let out = char;

		if (inDoubleString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inDoubleString = false;
			}
		} else if (inSingleString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === "'") {
				inSingleString = false;
				out = '"';
			}
		} else {
			if (char === '"') {
				inDoubleString = true;
			} else if (char === "'") {
				inSingleString = true;
				out = '"';
			}
		}

		result += out;
	}

	return result;
}

function balancedJsonCandidates(text: string): string[] {
	const candidates: string[] = [];
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (char !== "{" && char !== "[") continue;
		const end = balancedJsonEnd(text, index);
		if (end === null) continue;
		candidates.push(text.slice(index, end + 1));
		index = end;
	}
	return candidates;
}

function balancedJsonEnd(text: string, start: number): number | null {
	const stack: string[] = [];
	let inString = false;
	let escaped = false;

	for (let index = start; index < text.length; index += 1) {
		const char = text[index];
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === '"') inString = false;
			continue;
		}

		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{" || char === "[") {
			stack.push(char);
			continue;
		}
		if (char !== "}" && char !== "]") continue;

		const open = stack.pop();
		if ((open === "{" && char !== "}") || (open === "[" && char !== "]")) {
			return null;
		}
		if (stack.length === 0) return index;
	}

	return null;
}
