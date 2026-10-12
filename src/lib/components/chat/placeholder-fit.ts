// A composer placeholder that fits its field on one line.
//
// Beside a docked panel the chat column is 320-420 px, and the placeholder that
// names the open item ("Kérdezz erről: <title>") wrapped to two lines whenever the
// item's title was long (RC-A, the owner's principle: short words that do not
// crowd a row). The title is the last words of the text, so it is what gives way:
// the text is cut at a word and ends in an ellipsis, and never wraps.

const ELLIPSIS = "…";
/** What may hang off the end of the kept words before the ellipsis: a dash or a colon says nothing alone. */
const TRAILING_SEPARATORS = /[\s:;,.\-–—]+$/;

/** The width, in px, the given text takes in the field's placeholder font. */
export type MeasureText = (text: string) => number;

/** How much of the room a cut at a word has to fill before a cut at a letter is not worth its half word. */
const WORD_CUT_MIN_FILL = 0.6;

function trimmed(start: string): string {
	return start.replace(TRAILING_SEPARATORS, "");
}

/** The longest start of `text`, in whole words, that fits with an ellipsis, or null when not even one word does. */
function startInWords(
	text: string,
	room: number,
	measure: MeasureText,
): string | null {
	const words = text.split(" ");
	for (let kept = words.length - 1; kept >= 1; kept -= 1) {
		const start = trimmed(words.slice(0, kept).join(" "));
		if (start === "") continue;
		const candidate = `${start}${ELLIPSIS}`;
		if (measure(candidate) <= room) return candidate;
	}
	return null;
}

/** The longest start of `text`, letter by letter, that fits with an ellipsis. */
function startInLetters(
	text: string,
	room: number,
	measure: MeasureText,
): string {
	const letters = [...text];
	for (let kept = letters.length - 1; kept >= 1; kept -= 1) {
		const start = trimmed(letters.slice(0, kept).join(""));
		if (start === "") continue;
		const candidate = `${start}${ELLIPSIS}`;
		if (measure(candidate) <= room) return candidate;
	}
	return ELLIPSIS;
}

/**
 * `text` when it fits in `room` px, else its start that fits with an ellipsis: cut at
 * a word, unless that leaves most of the room empty (a title that is one long word
 * would be dropped altogether), then at a letter. Never longer than `text`, and
 * never empty for non-empty input.
 */
export function fitPlaceholder(
	text: string,
	room: number,
	measure: MeasureText,
): string {
	if (!(room > 0) || measure(text) <= room) return text;
	const byWords = startInWords(text, room, measure);
	if (byWords !== null && measure(byWords) >= room * WORD_CUT_MIN_FILL) {
		return byWords;
	}
	const byLetters = startInLetters(text, room, measure);
	return byWords !== null && byWords.length > byLetters.length
		? byWords
		: byLetters;
}

/**
 * A `MeasureText` for a field's placeholder, from the browser's own canvas and the
 * font the placeholder is drawn in. `null` where there is no canvas (a test
 * renderer): the placeholder is then left as it is.
 */
export function placeholderMeasurer(
	field: HTMLTextAreaElement,
): MeasureText | null {
	const context = document.createElement("canvas").getContext("2d");
	if (!context) return null;
	const style = getComputedStyle(field, "::placeholder");
	if (!style.fontSize) return null;
	context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
	return (text) => context.measureText(text).width;
}

/** The width a field gives its text: its own width less its padding. */
export function fieldTextRoom(field: HTMLTextAreaElement): number {
	const style = getComputedStyle(field);
	return (
		field.clientWidth -
		Number.parseFloat(style.paddingLeft || "0") -
		Number.parseFloat(style.paddingRight || "0")
	);
}
