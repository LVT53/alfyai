const REGION_CODE_PATTERN = /^[A-Z]{2}$/;
const FLAG_CODEPOINT_OFFSET = 127397;

function normalizeRegionCode(code: string | null | undefined): string | null {
	const normalized = code?.trim().toUpperCase() ?? "";
	return REGION_CODE_PATTERN.test(normalized) ? normalized : null;
}

export function regionCodeToFlag(code: string | null | undefined): string {
	const normalized = normalizeRegionCode(code);
	if (!normalized) return "";
	return Array.from(normalized)
		.map((letter) =>
			String.fromCodePoint(letter.charCodeAt(0) + FLAG_CODEPOINT_OFFSET),
		)
		.join("");
}

export function regionDisplayName(
	code: string | null | undefined,
	locale = "en",
): string {
	const normalized = normalizeRegionCode(code);
	if (!normalized) return "";
	try {
		const displayNames = new Intl.DisplayNames([locale], { type: "region" });
		return displayNames.of(normalized) ?? normalized;
	} catch {
		return normalized;
	}
}
