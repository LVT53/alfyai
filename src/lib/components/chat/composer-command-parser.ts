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

export type ComposerCommandTokenWithArgument = ComposerCommandToken & {
	/** The canonical command id the typed token matched (e.g. "document"). */
	command: string;
	/** Trimmed free-text typed after the command name, if any. */
	argument?: string;
};

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Generalizes the old `/document <query>`-only lookahead: recognizes
 * `/<commandId> rest of line` for any command id in `commandIds`, capturing
 * everything after the command name (up to the cursor, on the same line) as
 * its `argument`. Unlike `findActiveComposerCommandToken`, this only matches
 * a token that is anchored at the START of the active `/word...` run — it
 * does not match `$` tokens or bare command names outside `commandIds`.
 */
export function findActiveComposerCommandTokenWithArgument(
	text: string,
	cursor: number,
	commandIds: readonly string[],
): ComposerCommandTokenWithArgument | null {
	if (commandIds.length === 0) return null;

	const safeCursor = Math.max(0, Math.min(cursor, text.length));
	const beforeCursor = text.slice(0, safeCursor);
	const alternation = commandIds.map(escapeRegExp).join("|");
	const pattern = new RegExp(`(^|\\s)/(${alternation})(?:\\s+([^\\n\\r]*))?$`);
	const match = pattern.exec(beforeCursor);
	if (!match) return null;

	const start = match.index + match[1].length;
	const command = match[2];
	const argumentText = (match[3] ?? "").trim();

	return {
		prefix: "/",
		query: argumentText ? `${command} ${argumentText}` : command,
		start,
		end: safeCursor,
		token: text.slice(start, safeCursor),
		command,
		argument: argumentText || undefined,
	};
}
