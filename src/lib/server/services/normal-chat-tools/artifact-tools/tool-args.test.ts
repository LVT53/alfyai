import { describe, expect, it } from "vitest";
import { jsonArrayArg, textArgProblem } from "./tool-args";

describe("textArgProblem — an array argument that arrived as text", () => {
	it("says nothing about a value that is not text, so the schema's own message stands", () => {
		expect(textArgProblem("ops", 5)).toBeUndefined();
		expect(textArgProblem("ops", { op: "move" })).toBeUndefined();
		expect(textArgProblem("ops", undefined)).toBeUndefined();
	});

	it("names the argument, that it is JSON the tool call could not read, where it went wrong and what to check", () => {
		// One brace short after a nested list: the usual slip.
		const text = `[{"op":"add_node","node":{"id":"a","data":{"items":[{"id":"1"}]}}, {"op":"add_edge"}]`;
		const problem = textArgProblem("ops", text);
		expect(problem).toMatch(
			/^ops arrived as text, not as an array: it is not valid JSON/,
		);
		expect(problem).toMatch(/at character \d+/);
		expect(problem).toContain(`{"op":"add_edge"}`);
		expect(problem).toMatch(/every \{ and \[ is closed/);
	});

	it("says JSON text that is readable but not an array is not an array", () => {
		expect(textArgProblem("patches", '{"op":"replaceBlock"}')).toMatch(
			/patches arrived as text.*JSON, but not an array/,
		);
	});
});

describe("jsonArrayArg", () => {
	const schema = jsonArrayArg("ops").min(1).max(40);

	it("accepts an array and keeps the size bounds' own messages", () => {
		expect(schema.safeParse([{}]).success).toBe(true);
		expect(schema.safeParse([]).error?.issues[0]?.message).toMatch(/>=1/);
	});

	it("answers a string with what is wrong with it, not with 'expected array, received string'", () => {
		const parsed = schema.safeParse('[{"op": "move"');
		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues[0]?.message).toMatch(
			/^ops arrived as text, not as an array/,
		);
	});

	it("leaves any other wrong type to the schema's own message", () => {
		expect(schema.safeParse(7).error?.issues[0]?.message).toMatch(
			/expected array/,
		);
	});
});
