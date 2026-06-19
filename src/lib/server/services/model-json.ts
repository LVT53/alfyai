export function parseModelJsonValue(content: string): unknown | null {
	const trimmed = content.trim();
	if (!trimmed) return null;

	for (const candidate of jsonCandidates(trimmed)) {
		try {
			const parsed = JSON.parse(candidate) as unknown;
			if (parsed && typeof parsed === "object") return parsed;
		} catch {
			// Try the next candidate.
		}
	}
	return null;
}

export function parseModelJsonObject(
	content: string,
): Record<string, unknown> | null {
	const parsed = parseModelJsonValue(content);
	if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
		return parsed as Record<string, unknown>;
	}
	return null;
}

function jsonCandidates(content: string): string[] {
	const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
	const candidates = [content];
	if (fenced) candidates.unshift(fenced);

	const danglingOpeningBraceCandidate =
		extractDanglingOpeningBraceCandidate(content);
	if (danglingOpeningBraceCandidate) {
		candidates.push(danglingOpeningBraceCandidate);
	}

	const outerObject = extractOuterJsonObjectCandidate(content);
	if (outerObject) {
		candidates.push(outerObject);
	}

	candidates.push(...balancedJsonObjectCandidates(content));
	return [...new Set(candidates)];
}

function extractDanglingOpeningBraceCandidate(content: string): string {
	if (!content.startsWith("{")) {
		return "";
	}

	const candidate = content.slice(1).trimStart();
	return candidate.startsWith("{") ? candidate : "";
}

function extractOuterJsonObjectCandidate(content: string): string {
	const firstBrace = content.indexOf("{");
	const lastBrace = content.lastIndexOf("}");

	if (firstBrace < 0 || lastBrace <= firstBrace) {
		return "";
	}

	return content.slice(firstBrace, lastBrace + 1);
}

interface JsonRange {
	start: number;
	end: number;
}

function createJsonRange(start = -1): JsonRange {
	return { start, end: -1 };
}

interface JsonScanState {
	depth: number;
	inString: boolean;
	escaped: boolean;
	currentRange: JsonRange;
	ranges: JsonRange[];
}

function buildJsonScanState(): JsonScanState {
	return {
		depth: 0,
		inString: false,
		escaped: false,
		currentRange: createJsonRange(),
		ranges: [],
	};
}

function collectBalancedJsonObjectRanges(content: string): JsonRange[] {
	const state = buildJsonScanState();

	for (let index = 0; index < content.length; index += 1) {
		const char = content[index];
		if (state.inString) {
			if (state.escaped) {
				state.escaped = false;
				continue;
			}
			if (char === "\\") {
				state.escaped = true;
				continue;
			}
			if (char === '"') {
				state.inString = false;
			}
			continue;
		}

		if (char === '"') {
			state.inString = true;
			continue;
		}

		if (char === "{") {
			if (state.depth === 0) {
				state.currentRange = createJsonRange(index);
			}
			state.depth += 1;
			continue;
		}

		if (char === "}" && state.depth > 0) {
			state.depth -= 1;
			if (state.depth === 0 && state.currentRange.start >= 0) {
				state.currentRange.end = index + 1;
				state.ranges.push(state.currentRange);
				state.currentRange = createJsonRange();
			}
		}
	}

	return state.ranges;
}

function balancedJsonObjectCandidates(content: string): string[] {
	const ranges = collectBalancedJsonObjectRanges(content);

	return ranges
		.reverse()
		.map((range) => content.slice(range.start, range.end).trim())
		.filter(Boolean);
}

export function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function booleanValue(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

export function numberValue(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function stringArrayValue(value: unknown): string[] {
	return Array.isArray(value)
		? value
				.filter((item): item is string => typeof item === "string")
				.map((item) => item.replace(/\s+/g, " ").trim())
				.filter(Boolean)
		: [];
}

export function objectArrayValue(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value)
		? value.filter(
				(item): item is Record<string, unknown> =>
					Boolean(item) && typeof item === "object" && !Array.isArray(item),
			)
		: [];
}
