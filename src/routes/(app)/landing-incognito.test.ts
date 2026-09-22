import { describe, expect, it } from "vitest";
import { shouldShowIncognitoArm } from "./landing-incognito";

describe("shouldShowIncognitoArm", () => {
	// The revision this function exists to pin (2026-09-22). Typing a draft,
	// attaching a file or pasting one all create the landing page's prepared
	// conversation; none of them is a message, and none of them may take the
	// button away — the button used to be keyed on that conversation's id and
	// so vanished at the first keystroke. There is deliberately no parameter
	// to pass that id in, so a call site cannot quietly start gating on it
	// again: this test is as much about the signature as about the result.
	it("shows the button until a message has been sent, whatever draft conversation exists", () => {
		expect(
			shouldShowIncognitoArm({ messageSendStarted: false, armed: false }),
		).toBe(true);
	});

	it("goes once the send has begun", () => {
		expect(
			shouldShowIncognitoArm({ messageSendStarted: true, armed: false }),
		).toBe(false);
	});

	// One-way: the button is how incognito is armed, never how it is disarmed,
	// so it has no business still being there once it has been used.
	it("goes once incognito is armed", () => {
		expect(
			shouldShowIncognitoArm({ messageSendStarted: false, armed: true }),
		).toBe(false);
		expect(
			shouldShowIncognitoArm({ messageSendStarted: true, armed: true }),
		).toBe(false);
	});
});
