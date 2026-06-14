export type TextLinkSegment =
	| { kind: "text"; text: string }
	| { kind: "link"; text: string; href: string };

const URL_MATCH_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const TRAILING_URL_PUNCTUATION_PATTERN = /[),.!?:;]+$/;

export function tokenizeTextLinks(text: string): TextLinkSegment[] {
	if (!text) return [];
	const segments: TextLinkSegment[] = [];
	let currentIndex = 0;
	let hasLink = false;

	for (const match of text.matchAll(URL_MATCH_PATTERN)) {
		const rawUrl = match[0];
		const rawStart = match.index ?? 0;
		const visibleUrl = rawUrl.replace(TRAILING_URL_PUNCTUATION_PATTERN, "");
		if (!visibleUrl) continue;
		const visibleEnd = rawStart + visibleUrl.length;

		if (rawStart > currentIndex) {
			segments.push({ kind: "text", text: text.slice(currentIndex, rawStart) });
		}
		segments.push({
			kind: "link",
			text: visibleUrl,
			href: visibleUrl.startsWith("www.")
				? `https://${visibleUrl}`
				: visibleUrl,
		});
		hasLink = true;
		currentIndex = visibleEnd;
	}

	if (!hasLink) return [];
	if (currentIndex < text.length) {
		segments.push({ kind: "text", text: text.slice(currentIndex) });
	}
	return segments;
}
