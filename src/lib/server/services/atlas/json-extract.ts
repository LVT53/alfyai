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
