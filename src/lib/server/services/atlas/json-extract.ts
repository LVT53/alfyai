export function parseJsonFromText(text: string): unknown | null {
	for (const candidate of jsonCandidates(text)) {
		try {
			return JSON.parse(candidate) as unknown;
		} catch {
			// Try the next candidate.
		}
	}
	return null;
}

function jsonCandidates(text: string): string[] {
	const trimmed = text.trim();
	if (!trimmed) return [];

	const candidates: string[] = [trimmed];
	for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
		const fenced = match[1]?.trim();
		if (fenced) candidates.push(fenced);
	}
	candidates.push(...balancedJsonCandidates(trimmed));

	const seen = new Set<string>();
	return candidates.filter((candidate) => {
		const normalized = candidate.trim();
		if (!normalized || seen.has(normalized)) return false;
		seen.add(normalized);
		return true;
	});
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
