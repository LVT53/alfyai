import { describe, expect, it } from "vitest";
import { type ComposerKeyEvent, isComposerSendKey } from "./composer-keys";

function key(init: Partial<ComposerKeyEvent> = {}): ComposerKeyEvent {
	return {
		key: "Enter",
		metaKey: false,
		ctrlKey: false,
		shiftKey: false,
		altKey: false,
		keyCode: 13,
		isComposing: false,
		...init,
	};
}

const BOX_RULE = { sendWithEnter: false, touchScreen: false };
const SEND_WITH_ENTER = { sendWithEnter: true, touchScreen: false };

describe("isComposerSendKey: the box's own rule", () => {
	it("sends on Ctrl+Enter and Cmd+Enter", () => {
		expect(isComposerSendKey(key({ ctrlKey: true }), BOX_RULE)).toBe(true);
		expect(isComposerSendKey(key({ metaKey: true }), BOX_RULE)).toBe(true);
	});

	it("leaves Enter and Shift+Enter to write a new line", () => {
		expect(isComposerSendKey(key(), BOX_RULE)).toBe(false);
		expect(isComposerSendKey(key({ shiftKey: true }), BOX_RULE)).toBe(false);
	});

	it("is only about Enter", () => {
		expect(
			isComposerSendKey(
				key({ key: "a", keyCode: 65, ctrlKey: true }),
				BOX_RULE,
			),
		).toBe(false);
	});
});

describe("isComposerSendKey with Send with Enter", () => {
	it("sends on Enter, and still on Ctrl+Enter and Cmd+Enter", () => {
		expect(isComposerSendKey(key(), SEND_WITH_ENTER)).toBe(true);
		expect(isComposerSendKey(key({ ctrlKey: true }), SEND_WITH_ENTER)).toBe(
			true,
		);
		expect(isComposerSendKey(key({ metaKey: true }), SEND_WITH_ENTER)).toBe(
			true,
		);
	});

	it("leaves Shift+Enter and Alt+Enter to write a new line", () => {
		expect(isComposerSendKey(key({ shiftKey: true }), SEND_WITH_ENTER)).toBe(
			false,
		);
		expect(isComposerSendKey(key({ altKey: true }), SEND_WITH_ENTER)).toBe(
			false,
		);
	});

	it("keeps the box's own rule on a touch-only screen, which has no Shift+Enter", () => {
		const touch = { sendWithEnter: true, touchScreen: true };
		expect(isComposerSendKey(key(), touch)).toBe(false);
		expect(isComposerSendKey(key({ ctrlKey: true }), touch)).toBe(true);
	});
});

describe("isComposerSendKey while an input method composes", () => {
	it("never sends on the Enter that picks a word", () => {
		for (const options of [BOX_RULE, SEND_WITH_ENTER]) {
			expect(isComposerSendKey(key({ isComposing: true }), options)).toBe(
				false,
			);
			expect(
				isComposerSendKey(key({ isComposing: true, ctrlKey: true }), options),
			).toBe(false);
		}
	});

	it("reads Safari's keyCode 229 as composing too", () => {
		expect(isComposerSendKey(key({ keyCode: 229 }), SEND_WITH_ENTER)).toBe(
			false,
		);
	});
});
