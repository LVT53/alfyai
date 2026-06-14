export function estimateTokenCount(text: string): number {
	const trimmed = text.trim();
	if (!trimmed) return 0;

	const segments = trimmed.match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]+/gu) ?? [];
	let estimated = 0;

	for (const segment of segments) {
		if (/^[\p{L}\p{N}]+$/u.test(segment)) {
			const isAscii = Array.from(segment).every(
				(character) => (character.codePointAt(0) ?? 0) <= 0x7f,
			);
			estimated += Math.max(1, Math.ceil(segment.length / (isAscii ? 4 : 2)));
			continue;
		}

		estimated += segment.length;
	}

	return estimated;
}
