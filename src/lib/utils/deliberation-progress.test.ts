import { describe, expect, it } from "vitest";
import {
	type DeliberationProgressState,
	deriveDeliberationProgressState,
} from "./deliberation-progress";

// P4 (ADR-0056) — pure lifecycle-event -> progress-state tests. No model
// call, no Svelte, no streaming machinery: mirrors reasoning-spine.test.ts's
// convention for the same reason — the determinate rail is asserted purely
// against its declared inputs.
describe("deriveDeliberationProgressState", () => {
	it("is the standard-depth default: no passTotal ever emitted (empty plan) yields none, leaving P1's spine as the only signal", () => {
		expect(
			deriveDeliberationProgressState({
				draftingAnswerReached: false,
				answerStarted: false,
			}),
		).toEqual<DeliberationProgressState>({ kind: "none" });
	});

	it("yields none for a single-pass plan (extended depth) even once drafting is reached — no determinate progress to add for a plan of 1", () => {
		expect(
			deriveDeliberationProgressState({
				passIndex: 1,
				passTotal: 1,
				draftingAnswerReached: true,
				answerStarted: false,
			}),
		).toEqual<DeliberationProgressState>({ kind: "none" });
	});

	it("reports pass N of M while a multi-pass plan is mid-flight", () => {
		expect(
			deriveDeliberationProgressState({
				passIndex: 2,
				passTotal: 6,
				draftingAnswerReached: false,
				answerStarted: false,
			}),
		).toEqual<DeliberationProgressState>({ kind: "pass", index: 2, total: 6 });
	});

	it("ignores the workspace-preparation pseudo-pass (passIndex 0) as not yet a countable pass", () => {
		expect(
			deriveDeliberationProgressState({
				passIndex: 0,
				passTotal: 6,
				draftingAnswerReached: false,
				answerStarted: false,
			}),
		).toEqual<DeliberationProgressState>({ kind: "none" });
	});

	it("flips to concluding once deliberation has fully resolved (drafting-answer reached), even if the last visible pass index never reached the real total — most maximum-depth tail passes run silently", () => {
		expect(
			deriveDeliberationProgressState({
				passIndex: 1,
				passTotal: 6,
				draftingAnswerReached: true,
				answerStarted: false,
			}),
		).toEqual<DeliberationProgressState>({ kind: "concluding" });
	});

	it("concluding does not require any live passIndex at all, only a known multi-pass total and drafting-answer reached", () => {
		expect(
			deriveDeliberationProgressState({
				passTotal: 6,
				draftingAnswerReached: true,
				answerStarted: false,
			}),
		).toEqual<DeliberationProgressState>({ kind: "concluding" });
	});

	it("defers to none (and therefore P1's writing_answer) once the visible answer has started, even mid-plan", () => {
		expect(
			deriveDeliberationProgressState({
				passIndex: 3,
				passTotal: 6,
				draftingAnswerReached: false,
				answerStarted: true,
			}),
		).toEqual<DeliberationProgressState>({ kind: "none" });
	});

	it("defers to none once the visible answer has started even when concluding would otherwise apply", () => {
		expect(
			deriveDeliberationProgressState({
				passTotal: 6,
				draftingAnswerReached: true,
				answerStarted: true,
			}),
		).toEqual<DeliberationProgressState>({ kind: "none" });
	});

	it("never returns pass or concluding for any input combination with passTotal <= 1 — the standard/extended guarantee", () => {
		for (const passTotal of [undefined, 0, 1]) {
			for (const draftingAnswerReached of [true, false]) {
				for (const passIndex of [undefined, 0, 1]) {
					const state = deriveDeliberationProgressState({
						passIndex,
						passTotal,
						draftingAnswerReached,
						answerStarted: false,
					});
					expect(state.kind).toBe("none");
				}
			}
		}
	});
});
