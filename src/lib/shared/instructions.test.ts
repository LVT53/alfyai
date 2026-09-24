import { describe, expect, it } from "vitest";
import {
	INSTRUCTIONS_MAX_CHARS,
	countInstructionChars,
	normalizeInstructionText,
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
		expect(validateInstructionInput("a".repeat(INSTRUCTIONS_MAX_CHARS))).toEqual(
			{
				ok: true,
				value: "a".repeat(INSTRUCTIONS_MAX_CHARS),
			},
		);
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
		expect(validateInstructionInput("   \n ")).toEqual({ ok: true, value: null });
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
			validateInstructionInput(
				`   ${"a".repeat(INSTRUCTIONS_MAX_CHARS)}   `,
			),
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
