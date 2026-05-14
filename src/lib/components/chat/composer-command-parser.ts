export type ComposerCommandPrefix = "/" | "$";

export type ComposerCommandToken = {
	prefix: ComposerCommandPrefix;
	query: string;
	start: number;
	end: number;
	token: string;
};

const PREFIXES = new Set(["/", "$"]);

function isTokenBoundary(char: string | undefined): boolean {
	return char === undefined || /\s/.test(char);
}

function isTokenTerminator(char: string | undefined): boolean {
	return char === undefined || /\s/.test(char);
}

export function findActiveComposerCommandToken(
	text: string,
	cursor: number,
): ComposerCommandToken | null {
	const safeCursor = Math.max(0, Math.min(cursor, text.length));
	let start = safeCursor;

	while (start > 0 && !isTokenTerminator(text[start - 1])) {
		start -= 1;
	}

	const prefix = text[start] as ComposerCommandPrefix | undefined;
	if (!prefix || !PREFIXES.has(prefix)) return null;
	if (!isTokenBoundary(text[start - 1])) return null;

	let end = safeCursor;
	while (end < text.length && !isTokenTerminator(text[end])) {
		end += 1;
	}

	const token = text.slice(start, end);
	if (token.length === 0) return null;
	if (/\s/.test(token)) return null;

	const query = text.slice(start + 1, safeCursor);
	if (prefix === "$" && /^\d/.test(query)) return null;

	return {
		prefix,
		query,
		start,
		end,
		token,
	};
}

export function replaceActiveComposerCommandToken(
	text: string,
	cursor: number,
	replacement: string,
): { text: string; cursor: number } | null {
	const token = findActiveComposerCommandToken(text, cursor);
	if (!token) return null;

	const nextText =
		text.slice(0, token.start) + replacement + text.slice(token.end);
	return {
		text: nextText,
		cursor: token.start + replacement.length,
	};
}
