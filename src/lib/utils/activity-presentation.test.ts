import { describe, expect, it } from "vitest";
import type { I18nKey } from "$lib/i18n";
import type {
	ResponseActivityEntry,
	ThoughtStepClassifierActivityClass,
} from "$lib/response-activity-types";
import { THOUGHT_STEP_CLASSIFIER_ACTIVITY_CLASSES } from "$lib/response-activity-types";
import type { ThinkingSegment } from "$lib/server/services/messages-types";
import {
	type DeliberationIconType,
	deliberationIconTypeForPassIndex,
	deliberationIconTypeForPassKind,
	formatDeliberationProgressLabel,
	isDeliberationActivityEntry,
	isDeliberationStatusSegment,
	isThoughtStepActivityEntry,
	isToolProgressActivity,
	parseDeliberationPassIndex,
	resolveDeliberationPassIndex,
	type ThoughtStepIconType,
	thoughtStepIconTypeForClass,
} from "./activity-presentation";

// Tier B2 (chat-experience-elevation §5) — the extracted core is the test
// surface. These assert the EXACT classification/labelling both ThinkingBlock
// and MessageBubble previously carried as independent copies, so the two can
// no longer drift. No Svelte, no streaming machinery — the interface is the
// test surface, mirroring reasoning-spine.test.ts / deliberation-progress.test.ts.

const statusSegment = (
	over: Partial<Extract<ThinkingSegment, { type: "status" }>> = {},
): ThinkingSegment => ({
	type: "status",
	id: "deliberation-pass-1",
	label: "Reviewing context and sources",
	status: "running",
	...over,
});

const activityEntry = (
	over: Partial<ResponseActivityEntry> = {},
): ResponseActivityEntry => ({
	id: "deliberation-pass-1",
	kind: "deliberation",
	status: "running",
	...over,
});

describe("isDeliberationStatusSegment", () => {
	it("is true for a deliberation-pass status segment with a non-empty label", () => {
		expect(isDeliberationStatusSegment(statusSegment())).toBe(true);
	});

	it("is false for a non-status segment", () => {
		expect(
			isDeliberationStatusSegment({ type: "text", content: "hello" }),
		).toBe(false);
	});

	it("is false for a status segment that is not a deliberation pass", () => {
		expect(
			isDeliberationStatusSegment(statusSegment({ id: "context-preparing" })),
		).toBe(false);
	});

	it("is false for a deliberation-pass status segment with a blank label", () => {
		expect(isDeliberationStatusSegment(statusSegment({ label: "   " }))).toBe(
			false,
		);
	});
});

describe("isDeliberationActivityEntry", () => {
	it("is true for a deliberation activity entry with a non-empty label", () => {
		expect(
			isDeliberationActivityEntry(activityEntry({ label: "Reviewing" })),
		).toBe(true);
	});

	it("is false when undefined", () => {
		expect(isDeliberationActivityEntry(undefined)).toBe(false);
	});

	it("is false for a non-deliberation kind", () => {
		expect(
			isDeliberationActivityEntry(
				activityEntry({ kind: "tool", label: "Searching" }),
			),
		).toBe(false);
	});

	it("is false for a deliberation entry with a blank label", () => {
		expect(isDeliberationActivityEntry(activityEntry({ label: "  " }))).toBe(
			false,
		);
	});
});

describe("isThoughtStepActivityEntry", () => {
	it("is true for a thought_step entry with a non-empty detail", () => {
		expect(
			isThoughtStepActivityEntry(
				activityEntry({
					id: "thought-step:a",
					kind: "thought_step",
					detail: "weighing-options",
				}),
			),
		).toBe(true);
	});

	it("is false for a thought_step entry with no detail", () => {
		expect(
			isThoughtStepActivityEntry(
				activityEntry({ id: "thought-step:a", kind: "thought_step" }),
			),
		).toBe(false);
	});

	it("is false for a non-thought_step kind", () => {
		expect(
			isThoughtStepActivityEntry(
				activityEntry({ kind: "deliberation", detail: "x" }),
			),
		).toBe(false);
	});
});

describe("isToolProgressActivity", () => {
	it("is true for a tool-progress:* entry with a non-empty label", () => {
		expect(
			isToolProgressActivity(
				activityEntry({
					id: "tool-progress:1",
					kind: "tool",
					label: "Let me run more targeted searches now.",
				}),
			),
		).toBe(true);
	});

	it("is false when the id is not a tool-progress id", () => {
		expect(
			isToolProgressActivity(
				activityEntry({ id: "tool:1", kind: "tool", label: "x" }),
			),
		).toBe(false);
	});

	it("is false when the label is blank", () => {
		expect(
			isToolProgressActivity(
				activityEntry({ id: "tool-progress:1", kind: "tool", label: "" }),
			),
		).toBe(false);
	});
});

describe("parseDeliberationPassIndex", () => {
	it("parses the positive integer out of a deliberation-pass-N id", () => {
		expect(parseDeliberationPassIndex("deliberation-pass-1")).toBe(1);
		expect(parseDeliberationPassIndex("deliberation-pass-6")).toBe(6);
		expect(parseDeliberationPassIndex("deliberation-pass-42")).toBe(42);
	});

	it("is case-insensitive", () => {
		expect(parseDeliberationPassIndex("Deliberation-Pass-3")).toBe(3);
	});

	it("returns null for a non-positive index", () => {
		expect(parseDeliberationPassIndex("deliberation-pass-0")).toBeNull();
	});

	it("returns null for a malformed / non-matching id", () => {
		expect(parseDeliberationPassIndex("deliberation-pass-")).toBeNull();
		expect(parseDeliberationPassIndex("context-preparing")).toBeNull();
		expect(parseDeliberationPassIndex("")).toBeNull();
	});
});

describe("resolveDeliberationPassIndex", () => {
	it("returns null when the status is undefined", () => {
		expect(resolveDeliberationPassIndex(undefined)).toBeNull();
	});

	it("prefers an explicit integer passIndex over the id", () => {
		expect(
			resolveDeliberationPassIndex({
				passIndex: 4,
				id: "deliberation-pass-9",
			}),
		).toBe(4);
	});

	it("trusts an explicit passIndex even when it is 0 (matching the pre-extraction behaviour)", () => {
		expect(
			resolveDeliberationPassIndex({ passIndex: 0, id: "deliberation-pass-3" }),
		).toBe(0);
	});

	it("falls back to parsing the id when there is no explicit passIndex", () => {
		expect(resolveDeliberationPassIndex({ id: "deliberation-pass-2" })).toBe(2);
	});

	it("returns null when neither an explicit passIndex nor a parseable id is present", () => {
		expect(
			resolveDeliberationPassIndex({ id: "context-preparing" }),
		).toBeNull();
	});

	it("ignores a non-integer passIndex and falls back to the id", () => {
		expect(
			resolveDeliberationPassIndex({
				passIndex: 1.5,
				id: "deliberation-pass-7",
			}),
		).toBe(7);
	});
});

describe("deliberationIconTypeForPassKind", () => {
	// The full catalogued DeliberationPassKind -> icon mapping, byte-identical
	// to what both components carried. A regression here is exactly the drift
	// this seam removes.
	const cases: Array<[string, DeliberationIconType]> = [
		["context_source_gap_review", "search"],
		["evidence_gap_review", "search"],
		["source_reconciliation", "search"],
		["missed_user_need_check", "clipboard-check"],
		["answer_plan_critique", "clipboard-check"],
		["final_format_style_check", "clipboard-check"],
		["contradiction_risk_check", "shield-alert"],
		["adversarial_edge_case_check", "shield-alert"],
		["hungarian_parity_check", "languages"],
		["workspace_synthesis", "layers"],
		["viable_alternatives_preservation", "bot"],
	];

	for (const [passKind, icon] of cases) {
		it(`maps ${passKind} -> ${icon}`, () => {
			expect(deliberationIconTypeForPassKind(passKind)).toBe(icon);
		});
	}

	it("returns null for an unknown pass kind", () => {
		expect(deliberationIconTypeForPassKind("some_future_pass")).toBeNull();
	});

	it("returns null for an absent pass kind", () => {
		expect(deliberationIconTypeForPassKind(undefined)).toBeNull();
	});
});

describe("deliberationIconTypeForPassIndex", () => {
	it("maps pass 1 -> search, pass 2 -> clipboard-check, otherwise shield-alert", () => {
		expect(deliberationIconTypeForPassIndex(1)).toBe("search");
		expect(deliberationIconTypeForPassIndex(2)).toBe("clipboard-check");
		expect(deliberationIconTypeForPassIndex(3)).toBe("shield-alert");
		expect(deliberationIconTypeForPassIndex(99)).toBe("shield-alert");
	});
});

describe('MessageBubble icon adapter (?? "search")', () => {
	// The live deliberation-status-line default: unknown/absent kind -> search.
	it("defaults an unknown pass kind to search", () => {
		expect(deliberationIconTypeForPassKind(undefined) ?? "search").toBe(
			"search",
		);
		expect(deliberationIconTypeForPassKind("nonsense") ?? "search").toBe(
			"search",
		);
	});
});

describe("ThinkingBlock icon adapter (?? pass-index fallback)", () => {
	// A known pass kind wins; an unknown kind falls through to the pass-index
	// heuristic derived from the id (defaulting to pass 1 when unparseable).
	const iconFor = (segment: { passKind?: string; id: string }) =>
		deliberationIconTypeForPassKind(segment.passKind) ??
		deliberationIconTypeForPassIndex(
			parseDeliberationPassIndex(segment.id) ?? 1,
		);

	it("uses the pass-kind icon when the kind is known", () => {
		expect(
			iconFor({ passKind: "workspace_synthesis", id: "deliberation-pass-5" }),
		).toBe("layers");
	});

	it("falls back to the id-derived pass-index icon when the kind is unknown", () => {
		expect(iconFor({ id: "deliberation-pass-1" })).toBe("search");
		expect(iconFor({ id: "deliberation-pass-2" })).toBe("clipboard-check");
		expect(iconFor({ id: "deliberation-pass-3" })).toBe("shield-alert");
	});

	it("defaults to pass 1 (search) when the id is unparseable and the kind is unknown", () => {
		expect(iconFor({ id: "deliberation-pass-" })).toBe("search");
	});
});

describe("thoughtStepIconTypeForClass", () => {
	const cases: Array<
		[ThoughtStepClassifierActivityClass, ThoughtStepIconType]
	> = [
		["understanding-request", "help-circle"],
		["recalling-context", "history"],
		["weighing-options", "scale"],
		["working-through-logic", "workflow"],
		["checking-details", "list-checks"],
		["drafting-approach", "pen-line"],
	];

	for (const [activityClass, icon] of cases) {
		it(`maps ${activityClass} -> ${icon}`, () => {
			expect(thoughtStepIconTypeForClass(activityClass)).toBe(icon);
		});
	}

	it("is exhaustive over the closed classifier activity-class enum", () => {
		for (const activityClass of THOUGHT_STEP_CLASSIFIER_ACTIVITY_CLASSES) {
			expect(thoughtStepIconTypeForClass(activityClass)).toBeTruthy();
		}
	});
});

describe("formatDeliberationProgressLabel", () => {
	// A fake translator that reproduces the real chat.deliberatingProgress
	// template shape without pulling in the Svelte i18n store.
	const translate: (
		key: I18nKey,
		params?: Record<string, string | number>,
	) => string = (key, params) => {
		if (key === "chat.deliberatingProgress" && params) {
			return `Deliberating: ${params.current}/${params.total} · ${params.label}`;
		}
		return String(key);
	};

	it("returns the empty string for a blank label", () => {
		expect(formatDeliberationProgressLabel("   ", 1, 6, translate)).toBe("");
	});

	it("builds the progress form when a current pass and a positive total are present", () => {
		expect(
			formatDeliberationProgressLabel(
				"Reviewing context and sources",
				1,
				6,
				translate,
			),
		).toBe("Deliberating: 1/6 · Reviewing context and sources");
	});

	it("trims the label before interpolating", () => {
		expect(
			formatDeliberationProgressLabel(
				"  Checking answer plan  ",
				2,
				6,
				translate,
			),
		).toBe("Deliberating: 2/6 · Checking answer plan");
	});

	it("returns the bare (trimmed) label when there is no current pass", () => {
		expect(
			formatDeliberationProgressLabel("Reviewing", null, 6, translate),
		).toBe("Reviewing");
	});

	it("returns the bare label when the total is missing or not a positive integer", () => {
		expect(
			formatDeliberationProgressLabel("Reviewing", 1, undefined, translate),
		).toBe("Reviewing");
		expect(formatDeliberationProgressLabel("Reviewing", 1, 0, translate)).toBe(
			"Reviewing",
		);
		expect(
			formatDeliberationProgressLabel("Reviewing", 1, 1.5, translate),
		).toBe("Reviewing");
	});

	it("ThinkingBlock adapter: shows progress even for an explicit pass 0 (current never null)", () => {
		// ThinkingBlock passes `resolveDeliberationPassIndex(segment) ?? 1`, so a
		// segment with an explicit passIndex of 0 keeps 0 (non-null) and renders
		// the progress form — the pre-extraction behaviour.
		const current =
			resolveDeliberationPassIndex({
				passIndex: 0,
				id: "deliberation-pass-3",
			}) ?? 1;
		expect(
			formatDeliberationProgressLabel("Reviewing", current, 6, translate),
		).toBe("Deliberating: 0/6 · Reviewing");
	});

	it("MessageBubble adapter: an explicit pass 0 collapses to the bare label (|| null)", () => {
		// MessageBubble passes `resolveDeliberationPassIndex(status) || null`, so a
		// falsy pass number (0) becomes null and the bare label shows — the
		// pre-extraction `if (current && ...)` truthiness gate.
		const current =
			resolveDeliberationPassIndex({
				passIndex: 0,
				id: "deliberation-pass-3",
			}) || null;
		expect(
			formatDeliberationProgressLabel("Reviewing", current, 6, translate),
		).toBe("Reviewing");
	});
});
