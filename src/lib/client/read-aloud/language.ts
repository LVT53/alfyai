/**
 * Read aloud's own language detector: the one exception to "no second reader"
 * (`src/lib/server/services/chat-turn/AGENTS.md`, after I4). It names each
 * paragraph's language only to pick a read-aloud voice and the speech
 * service's text rules, and to name a language that has no voice. Nothing the
 * chat decides reads it.
 *
 * tinyld (MIT) names 62 languages. Its browser build is an ES module of about
 * 800 kB, so it is imported lazily and never sits in the chat's first paint
 * (`check:artifact-chunks --chat-forbid tinyld`).
 */

/** A paragraph with fewer letters than this is not detected on its own: tinyld misreads single words. */
export const SHORT_PARAGRAPH_LETTERS = 40;

/** The detector: an ISO 639-1 code, or "" when it cannot tell; `only` limits it to those languages. */
export type Detect = (text: string, only?: readonly string[]) => string;

/** The languages that have voices. */
const VOICED: readonly string[] = ["en", "hu"];

let detector: Promise<Detect> | null = null;

/** tinyld's `detect`: an ISO 639-1 code, or "" when it cannot tell. Loaded once; a failed load is tried again next time. */
export function loadDetector(): Promise<Detect> {
	detector ??= import("tinyld").then(
		({ detect }) =>
			(text: string, only?: readonly string[]) =>
				detect(text, only ? { only: [...only] } : undefined),
		(error: unknown) => {
			detector = null;
			throw error;
		},
	);
	return detector;
}

const LETTER = /\p{L}/gu;

function letterCount(text: string): number {
	return text.match(LETTER)?.length ?? 0;
}

/**
 * One language code per paragraph, in order:
 * - a paragraph of at least {@link SHORT_PARAGRAPH_LETTERS} letters gets the code the detector names;
 * - any other paragraph takes the previous paragraph's code, and short paragraphs that open the reply take the first named code after them;
 * - when no paragraph is named, every paragraph gets the whole reply's language, English or Hungarian only ("" when neither).
 */
export function assignLanguages(
	paragraphs: readonly string[],
	detect: Detect,
): string[] {
	const named = paragraphs.map((text) =>
		letterCount(text) >= SHORT_PARAGRAPH_LETTERS ? detect(text) : "",
	);
	const firstNamed = named.find((code) => code !== "");
	if (firstNamed === undefined) {
		if (paragraphs.length === 0) return [];
		// Too little text to tell 62 languages apart ("Rendben." reads as French): a short
		// reply is only asked whether it is English or Hungarian. A language with no voice
		// is named only by a paragraph long enough to say so.
		const whole = detect(paragraphs.join("\n"), VOICED);
		return paragraphs.map(() => whole);
	}
	let previous = firstNamed;
	return named.map((code) => {
		if (code !== "") previous = code;
		return previous;
	});
}

/** The languages that have voices. */
export function isVoiced(code: string): code is "en" | "hu" {
	return code === "en" || code === "hu";
}

/** The language's name in the UI language, first letter upper-cased ("German", "Német"), or null when it has none. */
export function languageDisplayName(
	code: string,
	ui: "en" | "hu",
): string | null {
	if (code === "") return null;
	let name: string | undefined;
	try {
		name = new Intl.DisplayNames([ui], {
			type: "language",
			fallback: "none",
		}).of(code);
	} catch {
		return null;
	}
	if (!name) return null;
	return name.charAt(0).toLocaleUpperCase(ui) + name.slice(1);
}
