export function parseJsonArray(value: string | null): unknown[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

export function parseJsonRecord(value: string | null): Record<string, unknown> {
	if (!value) return {};
	try {
		const parsed = JSON.parse(value);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// Fall through to an empty object.
	}
	return {};
}

export function readSafeString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function readSafePositiveInteger(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	const integer = Math.floor(value);
	return integer > 0 ? integer : null;
}

export function readSafeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return Array.from(
		new Set(
			value
				.filter((entry): entry is string => typeof entry === "string")
				.map((entry) => entry.trim())
				.filter(Boolean),
		),
	);
}
