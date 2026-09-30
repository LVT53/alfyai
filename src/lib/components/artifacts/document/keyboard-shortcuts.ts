/**
 * The Document's keyboard shortcuts (G3): what a key event means to the
 * editor, and how a shortcut is written on a button. Pure — no `@tiptap/*`, no
 * component — so `DocumentToolbar.svelte` (whose source-scan test keeps it free
 * of the editor) and `ChangeBar.svelte` can show the same chords the editor
 * and `DocumentBody.svelte` act on.
 *
 * Two families, kept apart on purpose:
 *
 * - The reader's own text history: Undo (⌘Z / Ctrl+Z) and Redo (⇧⌘Z on a Mac,
 *   Ctrl+Y or Ctrl+Shift+Z elsewhere; ⌘Y and Ctrl+Y both work everywhere).
 *   This is the editor's history — what the reader typed. Alfy's changes are
 *   not in it (`document-editor.ts`'s `loadMarkdown`, `marks.ts`).
 * - Alfy's change, the pill's own Undo and Redo: ⌘⌥Z / Ctrl+Alt+Z and the same
 *   with Shift. A different chord (Alt is held), so it can never be mistaken
 *   for, or shadowed by, the text history above; the family of the comment
 *   composer's ⌘/Ctrl+Alt+M.
 */

export type HistoryShortcut = "undo" | "redo";

type KeyEventLike = Pick<
	KeyboardEvent,
	"key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"
> & { isComposing?: boolean };

/** ⌘ on a Mac (and iOS), Ctrl everywhere else; read once per call so a test can change it. */
export function isApplePlatform(): boolean {
	if (typeof navigator === "undefined") return false;
	const nav = navigator as Navigator & {
		userAgentData?: { platform?: string };
	};
	const platform = nav.userAgentData?.platform ?? nav.platform ?? "";
	return /mac|iphone|ipad|ipod/i.test(platform);
}

/**
 * The letter a key event stands for. The character the key printed wins (so a
 * QWERTZ keyboard's Z key, which sits where QWERTY has Y, is still Z). With
 * none — a layout with no Latin letter (Russian's Я is the Z key), or Option on
 * a Mac turning ⌥Z into Ω — the physical key stands in when `physicalFallback`
 * allows it.
 */
function letterOf(event: KeyEventLike, physicalFallback: boolean): string {
	if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase();
	if (!physicalFallback) return "";
	return /^Key([A-Z])$/.exec(event.code)?.[1].toLowerCase() ?? "";
}

/** The command modifier for this platform, and no other: ⌘ on a Mac, Ctrl elsewhere. */
function hasCommandModifier(event: KeyEventLike, apple: boolean): boolean {
	return apple
		? event.metaKey && !event.ctrlKey
		: event.ctrlKey && !event.metaKey;
}

/** The text-history command a key event asks for, or `null`. Never with Alt held (that is Alfy's change, below). */
export function historyShortcutFor(
	event: KeyEventLike,
	apple: boolean = isApplePlatform(),
): HistoryShortcut | null {
	if (event.isComposing || event.altKey) return null;
	if (!hasCommandModifier(event, apple)) return null;
	// A command chord never types a character, so the physical key is a safe
	// stand-in on any layout.
	const letter = letterOf(event, true);
	if (letter === "z") return event.shiftKey ? "redo" : "undo";
	if (letter === "y" && !event.shiftKey) return "redo";
	return null;
}

/**
 * The pill's own Undo / Redo of Alfy's change: the command modifier plus Alt,
 * plus Shift for Redo. On Windows and Linux Ctrl+Alt is AltGr on many
 * keyboards, where it types a character; the physical key is therefore only a
 * stand-in on a Mac (where ⌘ chords never type), and elsewhere the key must
 * really have reported Z.
 */
export function alfyChangeShortcutFor(
	event: KeyEventLike,
	apple: boolean = isApplePlatform(),
): HistoryShortcut | null {
	if (event.isComposing || !event.altKey) return null;
	if (!hasCommandModifier(event, apple)) return null;
	if (letterOf(event, apple) !== "z") return null;
	return event.shiftKey ? "redo" : "undo";
}

/** How a chord is written on a button: ⌘Z / ⇧⌘Z on a Mac, Ctrl+Z / Ctrl+Y elsewhere. */
export function historyShortcutLabel(
	action: HistoryShortcut,
	apple: boolean = isApplePlatform(),
): string {
	if (apple) return action === "undo" ? "⌘Z" : "⇧⌘Z";
	return action === "undo" ? "Ctrl+Z" : "Ctrl+Y";
}

/** The Alfy-change chord as written on the pill's buttons. */
export function alfyChangeShortcutLabel(
	action: HistoryShortcut,
	apple: boolean = isApplePlatform(),
): string {
	if (apple) return action === "undo" ? "⌥⌘Z" : "⇧⌥⌘Z";
	return action === "undo" ? "Ctrl+Alt+Z" : "Ctrl+Alt+Shift+Z";
}

/** `aria-keyshortcuts` for the history chords: every one that works, space-separated, in ARIA's own key names. */
export function historyAriaKeyShortcuts(
	action: HistoryShortcut,
	apple: boolean = isApplePlatform(),
): string {
	const mod = apple ? "Meta" : "Control";
	if (action === "undo") return `${mod}+Z`;
	return `${mod}+${apple ? "Shift+Z Meta+Y" : "Y Control+Shift+Z"}`;
}

/** `aria-keyshortcuts` for the Alfy-change chords. */
export function alfyChangeAriaKeyShortcuts(
	action: HistoryShortcut,
	apple: boolean = isApplePlatform(),
): string {
	const mod = apple ? "Meta" : "Control";
	return action === "undo" ? `${mod}+Alt+Z` : `${mod}+Alt+Shift+Z`;
}

/**
 * The chords for a board's selection (the Document's own is a text selection):
 * ⌘/Ctrl+Alt+M comments on it, the same chord that opens the Document's comment
 * composer, and ⌘/Ctrl+Alt+A asks Alfy about it. Alt is held, so neither is ever
 * the reader's own history, and Shift is not (that is Alfy's change, redone). The
 * physical key stands in on a Mac, where Option changes the character.
 */
export type SelectionChord = "comment" | "ask";

export function selectionChordFor(
	event: KeyEventLike,
	apple: boolean = isApplePlatform(),
): SelectionChord | null {
	if (event.isComposing || !event.altKey || event.shiftKey) return null;
	if (!hasCommandModifier(event, apple)) return null;
	const letter = letterOf(event, apple);
	if (letter === "m") return "comment";
	if (letter === "a") return "ask";
	return null;
}

/** A selection chord as written on a button: ⌥⌘M on a Mac, Ctrl+Alt+M elsewhere. */
export function selectionChordLabel(
	chord: SelectionChord,
	apple: boolean = isApplePlatform(),
): string {
	const letter = chord === "comment" ? "M" : "A";
	return apple ? `⌥⌘${letter}` : `Ctrl+Alt+${letter}`;
}

/** `aria-keyshortcuts` for a selection chord. */
export function selectionChordAriaKeyShortcuts(
	chord: SelectionChord,
	apple: boolean = isApplePlatform(),
): string {
	return `${apple ? "Meta" : "Control"}+Alt+${chord === "comment" ? "M" : "A"}`;
}
