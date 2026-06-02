export function repairMalformedToolCallJson(input: string): string | null {
	if (!input) return null;

	let repaired = input.trim();

	if (!repaired) return null;

	if (repaired.charCodeAt(0) === 0xfeff) {
		repaired = repaired.slice(1).trim();
	}

	repaired = repaired.replace(/\}([.,;:])\s*$/, "}");
	repaired = repaired.replace(/\}\s*\.\s*$/, "}");

	let openBraces = 0;
	let closeBraces = 0;
	for (const ch of repaired) {
		if (ch === "{") openBraces += 1;
		if (ch === "}") closeBraces += 1;
	}
	if (openBraces > closeBraces) {
		repaired += "}".repeat(openBraces - closeBraces);
	}

	try {
		JSON.parse(repaired);
	} catch {
		const lastBrace = repaired.lastIndexOf("}");
		if (lastBrace >= 0 && lastBrace < repaired.length - 1) {
			const truncated = repaired.slice(0, lastBrace + 1);
			let truncatedOpen = 0;
			let truncatedClose = 0;
			for (const ch of truncated) {
				if (ch === "{") truncatedOpen += 1;
				if (ch === "}") truncatedClose += 1;
			}
			if (truncatedOpen === truncatedClose) {
				repaired = truncated;
			}
		}

		try {
			JSON.parse(repaired);
		} catch {
			return null;
		}
	}

	return repaired === input ? null : repaired;
}
