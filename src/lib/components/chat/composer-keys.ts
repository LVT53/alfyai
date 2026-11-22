/**
 * Which Enter sends from the message box (`MessageInput.svelte`: a message,
 * a queued follow-up while a reply runs, and an edit held in the composer).
 *
 * The box's own rule: Enter writes a new line and Ctrl/Cmd+Enter sends.
 * "Send with Enter" (Settings > Profile, the `sendWithEnter` store) turns it
 * round: Enter sends and Shift+Enter writes the new line; Ctrl/Cmd+Enter still
 * sends, and Alt+Enter is left to write its new line. A touch-only screen keeps
 * the box's own rule whatever the setting says (the caller passes
 * `touchScreen`): its keyboard has no Shift+Enter, so an Enter that sent would
 * leave no way to write a new line there.
 *
 * An Enter an input method is still composing with never sends: it picks the
 * word. `isComposing` says so, and Safari's keydown for the Enter that ends a
 * composition says it only through `keyCode` 229 (MDN, "keydown events with
 * IME" on the keydown event's page).
 */
export type ComposerKeyEvent = Pick<
	KeyboardEvent,
	"key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "keyCode"
> & { isComposing?: boolean };

export function isComposerSendKey(
	event: ComposerKeyEvent,
	options: { sendWithEnter: boolean; touchScreen: boolean },
): boolean {
	if (event.key !== "Enter") return false;
	if (event.isComposing || event.keyCode === 229) return false;
	if (event.metaKey || event.ctrlKey) return true;
	if (!options.sendWithEnter || options.touchScreen) return false;
	return !event.shiftKey && !event.altKey;
}
