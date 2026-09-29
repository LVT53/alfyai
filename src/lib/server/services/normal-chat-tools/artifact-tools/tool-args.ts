// The array arguments of edit_artifact (`patches`, `ops`) are JSON the model
// writes inside a tool call, and the tool-call parser turns that text into an
// array. When the text has a slip in it — a brace short in a deeply nested block
// is the usual one — the parser cannot, and hands the tool the raw text: a STRING
// where an array was asked for. The schema's own message for that ("expected
// array, received string") says nothing about JSON, so a model that gets it sends
// the same slip again. This says what happened, where, and what to check
// (decisions.md ruling 62: a refusal names what would have worked).
import { z } from "zod";

/** How much of the text around the slip is quoted back: enough to find it. */
const CONTEXT_BEFORE = 60;
const CONTEXT_AFTER = 20;

/**
 * Where a piece of JSON text goes wrong — in words, and with the text around the
 * slip quoted back — or `null` when it parses. A brace short in a deeply nested
 * block is the usual slip, and the parser's own message ("Expected double-quoted
 * property name at position 975") is only findable with the text beside it.
 */
export function describeJsonSlip(
	input: string,
): { reason: string; near: string } | null {
	try {
		JSON.parse(input);
		return null;
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "it could not be read";
		const at = /position (\d+)/.exec(message);
		const reason = message.replace(/ in JSON at position \d+.*$/, "");
		if (!at) return { reason, near: "" };
		const position = Number(at[1]);
		return {
			reason: `${reason} at character ${position}`,
			near: ` Near: ...${input.slice(Math.max(0, position - CONTEXT_BEFORE), position + CONTEXT_AFTER)}...`,
		};
	}
}

/**
 * What is wrong with an array argument that arrived as text, or `undefined` for
 * anything else (the schema's own message then stands). Pure, and used by the
 * eval harness's copy of the gate so the two cannot say different things.
 */
export function textArgProblem(
	name: string,
	input: unknown,
): string | undefined {
	if (typeof input !== "string") return undefined;
	const slip = describeJsonSlip(input);
	if (slip === null) {
		return `${name} arrived as text, not as an array: it is JSON, but not an array. Send ${name} as the array itself, not as text.`;
	}
	return `${name} arrived as text, not as an array: it is not valid JSON (${slip.reason}).${slip.near} Send ${name} as the array itself, and check that every { and [ is closed, especially in nested lists.`;
}

/** `z.array(z.unknown())` whose message for a value that arrived as text says so (see above). */
export function jsonArrayArg(name: string) {
	return z.array(z.unknown(), {
		error: (issue) => textArgProblem(name, issue.input),
	});
}
