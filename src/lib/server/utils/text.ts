export function normalizeWhitespace(value: string | null | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

export function clipText(value: string, maxLength: number): string {
	const normalized = normalizeWhitespace(value);
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function clipNullableText(
	value: string | null | undefined,
	maxLength: number,
): string | null {
	const normalized = value ? normalizeWhitespace(value) : "";
	if (!normalized) return null;
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function previewText(
	value: string | null | undefined,
	limit: number,
): string | null {
	if (!value) return null;
	const normalized = value.replace(/\s+/g, " ").trim();
	if (!normalized) return null;
	return normalized.length > limit
		? `${normalized.slice(0, limit)}...`
		: normalized;
}
