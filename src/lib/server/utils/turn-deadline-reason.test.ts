import { describe, expect, it } from "vitest";
import {
	abortedByTurnDeadline,
	TurnDeadlineReason,
} from "./turn-deadline-reason";

describe("abortedByTurnDeadline", () => {
	it("is false for no signal and for a signal that has not been aborted", () => {
		expect(abortedByTurnDeadline(undefined)).toBe(false);
		expect(abortedByTurnDeadline(new AbortController().signal)).toBe(false);
	});

	it("is true for a signal the engine's deadline timer aborted", () => {
		const controller = new AbortController();
		controller.abort(new TurnDeadlineReason());

		expect(abortedByTurnDeadline(controller.signal)).toBe(true);
	});

	it.each([
		["no reason of its own", undefined],
		["the person's Stop", new Error("The user stopped the turn")],
		["a string that says deadline", "deadline"],
		["an error that says deadline", new Error("deadline")],
	])(
		"is false for a signal aborted with %s: only the engine's own reason counts",
		(_what, reason) => {
			const controller = new AbortController();
			controller.abort(reason);

			expect(abortedByTurnDeadline(controller.signal)).toBe(false);
		},
	);

	it("reads the reason of whichever source of a combined signal aborted first", () => {
		const stop = new AbortController();
		const clock = new AbortController();
		const combined = AbortSignal.any([stop.signal, clock.signal]);

		clock.abort(new TurnDeadlineReason());
		stop.abort(new Error("The user stopped the turn"));

		expect(abortedByTurnDeadline(combined)).toBe(true);
	});

	it("is false when a stop aborted the combined signal before the clock did", () => {
		const stop = new AbortController();
		const clock = new AbortController();
		const combined = AbortSignal.any([stop.signal, clock.signal]);

		stop.abort(new Error("The user stopped the turn"));
		clock.abort(new TurnDeadlineReason());

		expect(abortedByTurnDeadline(combined)).toBe(false);
	});

	it("is an error with the bare name and message an aborted tool's error text carries", () => {
		const reason = new TurnDeadlineReason();

		expect(reason).toBeInstanceOf(Error);
		expect(reason.message).toBe("deadline");
		expect(reason.name).toBe("TurnDeadlineReason");
	});
});
