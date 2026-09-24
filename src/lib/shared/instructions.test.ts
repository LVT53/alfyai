import { describe, expect, it } from "vitest";
import {
	countInstructionChars,
	INSTRUCTIONS_MAX_CHARS,
	normalizeInstructionText,
	resolveInstructionScopeApplication,
	validateInstructionInput,
} from "./instructions";

describe("countInstructionChars", () => {
	it("counts an accented Hungarian character as one", () => {
		expect(countInstructionChars("árvíztűrő")).toBe(9);
	});
	it("counts an emoji as one, not two", () => {
		expect(countInstructionChars("👍")).toBe(1);
		expect(countInstructionChars("a👍b")).toBe(3);
	});
	it("counts a 2,000-character string as exactly 2,000", () => {
		expect(countInstructionChars("a".repeat(INSTRUCTIONS_MAX_CHARS))).toBe(
			INSTRUCTIONS_MAX_CHARS,
		);
	});
});

describe("validateInstructionInput", () => {
	it("accepts text at exactly the limit", () => {
		expect(
			validateInstructionInput("a".repeat(INSTRUCTIONS_MAX_CHARS)),
		).toEqual({
			ok: true,
			value: "a".repeat(INSTRUCTIONS_MAX_CHARS),
		});
	});
	it("rejects text one character over the limit", () => {
		expect(
			validateInstructionInput("a".repeat(INSTRUCTIONS_MAX_CHARS + 1)),
		).toEqual({
			ok: false,
			error: "too_long",
		});
	});
	it("accepts a Hungarian accent at exactly the limit", () => {
		expect(
			validateInstructionInput("ő".repeat(INSTRUCTIONS_MAX_CHARS)),
		).toEqual({
			ok: true,
			value: "ő".repeat(INSTRUCTIONS_MAX_CHARS),
		});
	});
	it("rejects a Hungarian accent one over the limit", () => {
		expect(
			validateInstructionInput("ő".repeat(INSTRUCTIONS_MAX_CHARS + 1)),
		).toEqual({
			ok: false,
			error: "too_long",
		});
	});
	it("accepts an over-limit string of emoji by code points, not UTF-16 units", () => {
		// 1,001 emoji is 2,002 UTF-16 units but only 1,001 code points: must be accepted.
		expect(validateInstructionInput("👍".repeat(1001)).ok).toBe(true);
	});
	it("rejects 2,001 code points of emoji even though they are 4,002 UTF-16 units", () => {
		// The other direction of the same off-by-one: counting UTF-16 units
		// would have rejected this one 1,001 emoji early.
		expect(
			validateInstructionInput("👍".repeat(INSTRUCTIONS_MAX_CHARS + 1)),
		).toEqual({ ok: false, error: "too_long" });
		expect(
			validateInstructionInput("👍".repeat(INSTRUCTIONS_MAX_CHARS)).ok,
		).toBe(true);
	});
	it("rejects a non-string", () => {
		expect(validateInstructionInput(42)).toEqual({
			ok: false,
			error: "not_a_string",
		});
	});
	it("rejects a non-string that is not null", () => {
		expect(validateInstructionInput({ personalInstructions: "hi" })).toEqual({
			ok: false,
			error: "not_a_string",
		});
	});
	it("turns empty and whitespace-only text into an explicit clear", () => {
		expect(validateInstructionInput("   \n ")).toEqual({
			ok: true,
			value: null,
		});
	});
	it("accepts null as a clear", () => {
		expect(validateInstructionInput(null)).toEqual({ ok: true, value: null });
	});
	it("trims the stored text", () => {
		expect(validateInstructionInput("  keep it short  ")).toEqual({
			ok: true,
			value: "keep it short",
		});
	});
	it("measures the limit after trimming, so surrounding whitespace never pushes text over", () => {
		expect(
			validateInstructionInput(`   ${"a".repeat(INSTRUCTIONS_MAX_CHARS)}   `),
		).toEqual({ ok: true, value: "a".repeat(INSTRUCTIONS_MAX_CHARS) });
	});
});

describe("normalizeInstructionText", () => {
	it("returns null for whitespace only", () => {
		expect(normalizeInstructionText("\n\t ")).toBeNull();
	});
	it("returns the trimmed text otherwise", () => {
		expect(normalizeInstructionText("  be terse  ")).toBe("be terse");
	});
});

// The record the Info popover reads. It says which scopes applied and never
// what they said, so the mapping has to be a pure function of the resolved
// turn instructions — that is what keeps the persisted record in step with the
// prompt the model actually got.
describe("resolveInstructionScopeApplication", () => {
	it("marks personal instructions as applied", () => {
		expect(
			resolveInstructionScopeApplication({
				personal: "Use metric units.",
				project: null,
			}),
		).toEqual({ personal: true });
	});

	it("carries the project id when the project block applied", () => {
		expect(
			resolveInstructionScopeApplication({
				personal: null,
				project: { id: "project-1" },
			}),
		).toEqual({ personal: false, projectId: "project-1" });
	});

	it("carries both scopes when both applied", () => {
		expect(
			resolveInstructionScopeApplication({
				personal: "Use metric units.",
				project: { id: "project-1" },
			}),
		).toEqual({ personal: true, projectId: "project-1" });
	});

	it("returns nothing to show when neither scope applied", () => {
		expect(
			resolveInstructionScopeApplication({ personal: null, project: null }),
		).toBeUndefined();
		expect(resolveInstructionScopeApplication(null)).toBeUndefined();
		expect(resolveInstructionScopeApplication(undefined)).toBeUndefined();
	});

	it("treats an empty string as nothing applied, matching the prompt's own test", () => {
		// Prompt assembly renders no section for text that is empty, so a record
		// saying the scope applied would point at a section that is not there.
		// (Storage normalizes whitespace-only text to null before this point, so
		// "   " never arrives here.)
		expect(
			resolveInstructionScopeApplication({ personal: "", project: null }),
		).toBeUndefined();
	});
});
