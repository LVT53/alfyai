/**
 * Whose a ⌘/Ctrl+Z is, on a board (ruling 16): the reader's own steps have it
 * unless the reader is writing in a field, which has a text history of its own.
 *
 * The board used to take the chord only while the focus was INSIDE the board and
 * not on an `input`. A person's focus is seldom there: a click on the empty
 * board leaves it on the page's body (nothing in the board can take it), a
 * deleted block takes its focus with it, a block that was just inserted is
 * opened for typing so the focus is in a field with nothing to undo, and a tick
 * in a checklist leaves it on a checkbox, which is an `input` but not a place
 * words go. In each the chord did nothing, and the reader concluded that there
 * is no undo. The rule here is the one a person holds: the board is what is in
 * front of them, so the chord is the board's whenever the focus is on it or on
 * nothing, and is left alone only where words are being typed.
 *
 * Pure (an element and the document it is asked about), so it is tested without
 * a board.
 */
import {
	type HistoryShortcut,
	historyShortcutFor,
} from "$lib/components/artifacts/document/keyboard-shortcuts";

/** `input` types that are not a place words go: a chord pressed on one is not aimed at its text. */
const NOT_TEXT_INPUT_TYPES = new Set([
	"button",
	"checkbox",
	"color",
	"file",
	"image",
	"radio",
	"range",
	"reset",
	"submit",
]);

/** True for an element the reader types words into: it keeps ⌘/Ctrl+Z for its own text history. */
export function isTextEntry(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	const editable = target.closest<HTMLElement>(
		"input, textarea, [contenteditable]",
	);
	if (!editable) return false;
	if (editable instanceof HTMLInputElement) {
		return !NOT_TEXT_INPUT_TYPES.has(editable.type);
	}
	if (editable instanceof HTMLTextAreaElement) return true;
	return editable.getAttribute("contenteditable") !== "false";
}

/**
 * The history command a key event means for the board, or null when it is not one
 * or is not the board's: aimed at a field the reader types in, or made while the
 * focus is on something else (the chat's composer, a dialog). `nothing focused`
 * (the body, after a click on ground nothing can focus) is the board's.
 */
export function boardHistoryChord(
	event: KeyboardEvent,
	boardEl: HTMLElement | null,
	doc: Document = document,
): HistoryShortcut | null {
	if (event.defaultPrevented || !boardEl || !boardEl.isConnected) return null;
	const active = doc.activeElement;
	const nothingFocused =
		!active || active === doc.body || active === doc.documentElement;
	if (!nothingFocused && !boardEl.contains(active)) return null;
	if (isTextEntry(event.target)) return null;
	return historyShortcutFor(event);
}

/**
 * An attachment for a field that opens for typing the moment its block is
 * inserted (a new note, a new frame's name): while the reader has typed nothing
 * in it the field has nothing of its own to undo, so ⌘/Ctrl+Z means the board's
 * last step — the insert — and is handed over. Once the reader has typed, the
 * chord is the field's own text history for the rest of that edit, so a
 * reader's words and the board's steps are never undone by the same key press.
 */
export function handsHistoryToBoard(
	handOver: ((action: HistoryShortcut) => void) | undefined,
	leave: () => void,
): (field: HTMLElement) => () => void {
	return (field) => {
		if (!handOver) return () => {};
		let typed = false;
		const onInput = () => {
			typed = true;
		};
		const onKeydown = (event: KeyboardEvent) => {
			if (typed || event.defaultPrevented) return;
			const action = historyShortcutFor(event);
			if (!action) return;
			event.preventDefault();
			event.stopPropagation();
			leave();
			handOver(action);
		};
		field.addEventListener("input", onInput);
		field.addEventListener("keydown", onKeydown);
		return () => {
			field.removeEventListener("input", onInput);
			field.removeEventListener("keydown", onKeydown);
		};
	};
}
