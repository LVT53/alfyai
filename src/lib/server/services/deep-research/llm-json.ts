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

export function parseModelJsonObject(content: string): Record<string, unknown> | null {
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

	const withoutDanglingOpeningBrace = content.startsWith("{")
		? content.slice(1).trimStart()
		: "";
	if (withoutDanglingOpeningBrace.startsWith("{")) {
		candidates.push(withoutDanglingOpeningBrace);
	}

	const firstBrace = content.indexOf("{");
	const lastBrace = content.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) {
		candidates.push(content.slice(firstBrace, lastBrace + 1));
	}
	return [...new Set(candidates)];
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
