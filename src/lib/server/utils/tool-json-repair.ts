function normalizeToolCallInput(input: string): string {
	const trimmed = input.trim();
	return trimmed === "" ? "" : trimmed;
}

function stripByteOrderMarker(input: string): string {
	return input.charCodeAt(0) === 0xfeff ? input.slice(1).trim() : input;
}

function balanceClosingBraces(input: string): string {
	let openBraces = 0;
	let closeBraces = 0;
	for (const ch of input) {
		if (ch === "{") openBraces += 1;
		if (ch === "}") closeBraces += 1;
	}
	if (openBraces <= closeBraces) return input;
	return input + "}".repeat(openBraces - closeBraces);
}

function trimTrailingNoise(input: string): string {
	return input.replace(/\}([.,;:])\s*$/, "}").replace(/\}\s*\.\s*$/, "}");
}

function hasEqualBraceBalance(input: string): boolean {
	let openBraces = 0;
	let closeBraces = 0;
	for (const ch of input) {
		if (ch === "{") openBraces += 1;
		if (ch === "}") closeBraces += 1;
	}
	return openBraces === closeBraces;
}

function canParseJson(input: string): boolean {
	try {
		JSON.parse(input);
		return true;
	} catch {
		return false;
	}
}

function stripTrailingSuffixAfterLastBrace(input: string): string {
	const lastBrace = input.lastIndexOf("}");
	if (lastBrace < 0 || lastBrace === input.length - 1) {
		return input;
	}
	const truncated = input.slice(0, lastBrace + 1);
	return hasEqualBraceBalance(truncated) ? truncated : input;
}

export function repairMalformedToolCallJson(input: string): string | null {
	if (!input) return null;

	let repaired = normalizeToolCallInput(input);

	if (!repaired) return null;

	repaired = stripByteOrderMarker(repaired);
	repaired = trimTrailingNoise(repaired);
	repaired = balanceClosingBraces(repaired);

	if (canParseJson(repaired)) {
		return repaired === input ? null : repaired;
	}

	repaired = stripTrailingSuffixAfterLastBrace(repaired);
	if (!canParseJson(repaired)) {
		return null;
	}

	return repaired === input ? null : repaired;
}
