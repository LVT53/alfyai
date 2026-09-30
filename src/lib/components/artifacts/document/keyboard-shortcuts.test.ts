import { afterEach, describe, expect, it } from "vitest";
import {
	alfyChangeAriaKeyShortcuts,
	alfyChangeShortcutFor,
	alfyChangeShortcutLabel,
	historyAriaKeyShortcuts,
	historyShortcutFor,
	historyShortcutLabel,
	isApplePlatform,
	selectionChordAriaKeyShortcuts,
	selectionChordFor,
	selectionChordLabel,
} from "./keyboard-shortcuts";

function key(
	init: Partial<
		Pick<
			KeyboardEvent,
			"key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"
		>
	> & { isComposing?: boolean },
) {
	return {
		key: "",
		code: "",
		metaKey: false,
		ctrlKey: false,
		shiftKey: false,
		altKey: false,
		isComposing: false,
		...init,
	};
}

const setPlatform = (value: string | undefined) =>
	Object.defineProperty(window.navigator, "platform", {
		value,
		configurable: true,
	});

afterEach(() => {
	// jsdom's own value again.
	Reflect.deleteProperty(window.navigator, "platform");
});

describe("historyShortcutFor", () => {
	it("undoes with Ctrl+Z and redoes with Ctrl+Shift+Z and Ctrl+Y off a Mac", () => {
		expect(
			historyShortcutFor(key({ key: "z", code: "KeyZ", ctrlKey: true }), false),
		).toBe("undo");
		expect(
			historyShortcutFor(
				key({ key: "Z", code: "KeyZ", ctrlKey: true, shiftKey: true }),
				false,
			),
		).toBe("redo");
		expect(
			historyShortcutFor(key({ key: "y", code: "KeyY", ctrlKey: true }), false),
		).toBe("redo");
	});

	it("undoes with Cmd+Z and redoes with Cmd+Shift+Z and Cmd+Y on a Mac", () => {
		expect(
			historyShortcutFor(key({ key: "z", code: "KeyZ", metaKey: true }), true),
		).toBe("undo");
		expect(
			historyShortcutFor(
				key({ key: "Z", code: "KeyZ", metaKey: true, shiftKey: true }),
				true,
			),
		).toBe("redo");
		expect(
			historyShortcutFor(key({ key: "y", code: "KeyY", metaKey: true }), true),
		).toBe("redo");
	});

	it("does not mix the two: Ctrl+Z is not undo on a Mac, Cmd+Z is not undo elsewhere", () => {
		expect(
			historyShortcutFor(key({ key: "z", code: "KeyZ", ctrlKey: true }), true),
		).toBeNull();
		expect(
			historyShortcutFor(key({ key: "z", code: "KeyZ", metaKey: true }), false),
		).toBeNull();
	});

	it("ignores plain letters, other chords and a chord with Alt held (that is the Alfy change's own)", () => {
		expect(
			historyShortcutFor(key({ key: "z", code: "KeyZ" }), false),
		).toBeNull();
		expect(
			historyShortcutFor(key({ key: "x", code: "KeyX", ctrlKey: true }), false),
		).toBeNull();
		expect(
			historyShortcutFor(
				key({ key: "z", code: "KeyZ", ctrlKey: true, altKey: true }),
				false,
			),
		).toBeNull();
		// Ctrl+Shift+Y is not redo.
		expect(
			historyShortcutFor(
				key({ key: "Y", code: "KeyY", ctrlKey: true, shiftKey: true }),
				false,
			),
		).toBeNull();
	});

	it("follows the key the reader pressed, not its place on the board (QWERTZ: the Z key sits where QWERTY has Y)", () => {
		expect(
			historyShortcutFor(key({ key: "z", code: "KeyY", ctrlKey: true }), false),
		).toBe("undo");
		expect(
			historyShortcutFor(key({ key: "y", code: "KeyZ", ctrlKey: true }), false),
		).toBe("redo");
	});

	it("falls back to the physical key on a layout with no Latin letter (Russian: Я is the Z key)", () => {
		expect(
			historyShortcutFor(key({ key: "я", code: "KeyZ", ctrlKey: true }), false),
		).toBe("undo");
		expect(
			historyShortcutFor(
				key({ key: "Я", code: "KeyZ", ctrlKey: true, shiftKey: true }),
				false,
			),
		).toBe("redo");
	});

	it("leaves an IME composition alone", () => {
		expect(
			historyShortcutFor(
				key({ key: "z", code: "KeyZ", ctrlKey: true, isComposing: true }),
				false,
			),
		).toBeNull();
	});

	it("reads the platform itself when none is given", () => {
		setPlatform("MacIntel");
		expect(
			historyShortcutFor(key({ key: "z", code: "KeyZ", metaKey: true })),
		).toBe("undo");
		setPlatform("Linux x86_64");
		expect(
			historyShortcutFor(key({ key: "z", code: "KeyZ", ctrlKey: true })),
		).toBe("undo");
	});
});

describe("alfyChangeShortcutFor", () => {
	it("is Ctrl+Alt+Z to undo Alfy's change and Ctrl+Alt+Shift+Z to redo it, off a Mac", () => {
		expect(
			alfyChangeShortcutFor(
				key({ key: "z", code: "KeyZ", ctrlKey: true, altKey: true }),
				false,
			),
		).toBe("undo");
		expect(
			alfyChangeShortcutFor(
				key({
					key: "Z",
					code: "KeyZ",
					ctrlKey: true,
					altKey: true,
					shiftKey: true,
				}),
				false,
			),
		).toBe("redo");
	});

	it("is Cmd+Option+Z and Cmd+Option+Shift+Z on a Mac, where Option changes the character (Ω)", () => {
		expect(
			alfyChangeShortcutFor(
				key({ key: "Ω", code: "KeyZ", metaKey: true, altKey: true }),
				true,
			),
		).toBe("undo");
		expect(
			alfyChangeShortcutFor(
				key({
					key: "¸",
					code: "KeyZ",
					metaKey: true,
					altKey: true,
					shiftKey: true,
				}),
				true,
			),
		).toBe("redo");
	});

	it("does not take a character off a keyboard that types it with Ctrl+Alt (AltGr: key is the character, not z)", () => {
		expect(
			alfyChangeShortcutFor(
				key({ key: "ł", code: "KeyZ", ctrlKey: true, altKey: true }),
				false,
			),
		).toBeNull();
	});

	it("never overlaps the editor's own history shortcuts", () => {
		const plain = key({ key: "z", code: "KeyZ", ctrlKey: true });
		expect(alfyChangeShortcutFor(plain, false)).toBeNull();
		const alfy = key({ key: "z", code: "KeyZ", ctrlKey: true, altKey: true });
		expect(historyShortcutFor(alfy, false)).toBeNull();
	});

	it("ignores other letters and an IME composition", () => {
		expect(
			alfyChangeShortcutFor(
				key({ key: "m", code: "KeyM", ctrlKey: true, altKey: true }),
				false,
			),
		).toBeNull();
		expect(
			alfyChangeShortcutFor(
				key({
					key: "z",
					code: "KeyZ",
					ctrlKey: true,
					altKey: true,
					isComposing: true,
				}),
				false,
			),
		).toBeNull();
	});
});

describe("the shortcut texts", () => {
	it("shows Mac keys on a Mac and Ctrl chords elsewhere", () => {
		expect(historyShortcutLabel("undo", true)).toBe("⌘Z");
		expect(historyShortcutLabel("redo", true)).toBe("⇧⌘Z");
		expect(historyShortcutLabel("undo", false)).toBe("Ctrl+Z");
		expect(historyShortcutLabel("redo", false)).toBe("Ctrl+Y");
		expect(alfyChangeShortcutLabel("undo", true)).toBe("⌥⌘Z");
		expect(alfyChangeShortcutLabel("redo", true)).toBe("⇧⌥⌘Z");
		expect(alfyChangeShortcutLabel("undo", false)).toBe("Ctrl+Alt+Z");
		expect(alfyChangeShortcutLabel("redo", false)).toBe("Ctrl+Alt+Shift+Z");
	});

	it("gives assistive technology the same chords in ARIA's own notation, every one that works", () => {
		expect(historyAriaKeyShortcuts("undo", true)).toBe("Meta+Z");
		expect(historyAriaKeyShortcuts("redo", true)).toBe("Meta+Shift+Z Meta+Y");
		expect(historyAriaKeyShortcuts("undo", false)).toBe("Control+Z");
		expect(historyAriaKeyShortcuts("redo", false)).toBe(
			"Control+Y Control+Shift+Z",
		);
		expect(alfyChangeAriaKeyShortcuts("undo", true)).toBe("Meta+Alt+Z");
		expect(alfyChangeAriaKeyShortcuts("redo", false)).toBe(
			"Control+Alt+Shift+Z",
		);
	});
});

describe("isApplePlatform", () => {
	it("is true for a Mac, iPhone and iPad platform string only", () => {
		for (const platform of ["MacIntel", "iPhone", "iPad"]) {
			setPlatform(platform);
			expect(isApplePlatform()).toBe(true);
		}
		for (const platform of ["Win32", "Linux x86_64", "Android", ""]) {
			setPlatform(platform);
			expect(isApplePlatform()).toBe(false);
		}
	});

	it("prefers the newer userAgentData platform when the browser has one", () => {
		setPlatform("Win32");
		Object.defineProperty(window.navigator, "userAgentData", {
			value: { platform: "macOS" },
			configurable: true,
		});
		expect(isApplePlatform()).toBe(true);
		Reflect.deleteProperty(window.navigator, "userAgentData");
	});
});

// A board's selection: Comment is the Document's own chord (⌘/Ctrl+Alt+M), and
// Ask Alfy sits beside it (⌘/Ctrl+Alt+A). Neither is ever the reader's own undo.
describe("selectionChordFor", () => {
	it("is Ctrl+Alt+M to comment and Ctrl+Alt+A to ask Alfy, off a Mac", () => {
		expect(
			selectionChordFor(
				key({ key: "m", code: "KeyM", ctrlKey: true, altKey: true }),
				false,
			),
		).toBe("comment");
		expect(
			selectionChordFor(
				key({ key: "a", code: "KeyA", ctrlKey: true, altKey: true }),
				false,
			),
		).toBe("ask");
	});

	it("is Cmd+Option+M and Cmd+Option+A on a Mac, where Option changes the character", () => {
		expect(
			selectionChordFor(
				key({ key: "µ", code: "KeyM", metaKey: true, altKey: true }),
				true,
			),
		).toBe("comment");
		expect(
			selectionChordFor(
				key({ key: "å", code: "KeyA", metaKey: true, altKey: true }),
				true,
			),
		).toBe("ask");
	});

	it("needs the platform's command key, the Alt key, and no Shift", () => {
		expect(
			selectionChordFor(key({ key: "m", code: "KeyM", altKey: true }), false),
		).toBeNull();
		expect(
			selectionChordFor(key({ key: "m", code: "KeyM", ctrlKey: true }), false),
		).toBeNull();
		expect(
			selectionChordFor(
				key({
					key: "M",
					code: "KeyM",
					ctrlKey: true,
					altKey: true,
					shiftKey: true,
				}),
				false,
			),
		).toBeNull();
		// Ctrl is not the command key on a Mac.
		expect(
			selectionChordFor(
				key({ key: "m", code: "KeyM", ctrlKey: true, altKey: true }),
				true,
			),
		).toBeNull();
	});

	it("is not a chord while an input method is composing", () => {
		expect(
			selectionChordFor(
				key({
					key: "m",
					code: "KeyM",
					ctrlKey: true,
					altKey: true,
					isComposing: true,
				}),
				false,
			),
		).toBeNull();
	});

	it("is written on a button, and named for assistive technology, the way the platform reads it", () => {
		expect(selectionChordLabel("comment", false)).toBe("Ctrl+Alt+M");
		expect(selectionChordLabel("ask", false)).toBe("Ctrl+Alt+A");
		expect(selectionChordLabel("comment", true)).toBe("⌥⌘M");
		expect(selectionChordLabel("ask", true)).toBe("⌥⌘A");
		expect(selectionChordAriaKeyShortcuts("comment", false)).toBe(
			"Control+Alt+M",
		);
		expect(selectionChordAriaKeyShortcuts("ask", true)).toBe("Meta+Alt+A");
	});
});
