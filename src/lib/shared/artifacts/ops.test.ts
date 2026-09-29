// The shared mechanism (ruling 14) knows nothing about boards: these suites use
// a toy vocabulary — a stack of strings — so what is proved here is the
// mechanism's own contract, and Slides' `deck-ops.ts` can plug into it as the
// toy does.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	type OpRefusal,
	type OpsDiff,
	type OpsVocabulary,
	parseOpsEnvelope,
	runOps,
} from "./ops";

type Stack = { items: string[] };
type StackOp = { op: "push"; value: string } | { op: "pop" };
type StackReason = "empty" | "too_deep";

const stackDiffSchema = z.object({
	id: z.string().min(1),
	summary: z.string().min(1),
	ops: z
		.array(
			z.discriminatedUnion("op", [
				z.object({ op: z.literal("push"), value: z.string().min(1) }),
				z.object({ op: z.literal("pop") }),
			]),
		)
		.min(1)
		.max(10),
});

/** Sequential, like a real vocabulary: an op is judged against what the accepted ones before it left behind. */
const stackVocabulary: OpsVocabulary<Stack, StackOp, StackReason> = {
	opNames: ["push", "pop"],
	diffSchema: stackDiffSchema,
	validate(ops, doc) {
		const accepted: StackOp[] = [];
		const refused: OpRefusal<StackReason>[] = [];
		let depth = doc.items.length;
		ops.forEach((op, index) => {
			if (op.op === "pop" && depth === 0) {
				refused.push({
					index,
					op: "pop",
					reason: "empty",
					detail: "nothing to pop",
				});
			} else if (op.op === "push" && depth >= 3) {
				refused.push({
					index,
					op: "push",
					id: op.value,
					reason: "too_deep",
					detail: "the stack holds 3",
				});
			} else {
				depth += op.op === "push" ? 1 : -1;
				accepted.push(op);
			}
		});
		return { accepted, refused };
	},
	apply(doc, op) {
		return op.op === "push"
			? { items: [...doc.items, op.value] }
			: { items: doc.items.slice(0, -1) };
	},
};

function diff(...ops: StackOp[]): OpsDiff<StackOp> {
	return { id: "diff-1", summary: "Shuffled the stack", ops };
}

describe("parseOpsEnvelope", () => {
	it("reads the base version and the diff out of a payload", () => {
		expect(
			parseOpsEnvelope({ baseVersionId: "v1", diff: { any: "thing" } }),
		).toEqual({
			ok: true,
			baseVersionId: "v1",
			diff: { any: "thing" },
		});
	});

	it("refuses a payload that is not an envelope, saying what is missing", () => {
		for (const payload of [
			undefined,
			null,
			"x",
			[],
			{},
			{ diff: {} },
			{ baseVersionId: "", diff: {} },
			{ baseVersionId: 3, diff: {} },
			{ baseVersionId: "v1" },
			{ baseVersionId: "v1", diff: null },
			{ baseVersionId: "v1", diff: "nope" },
			{ baseVersionId: "v1", diff: [] },
		]) {
			const parsed = parseOpsEnvelope(payload);
			expect(parsed.ok).toBe(false);
			if (!parsed.ok) expect(parsed.detail.length).toBeGreaterThan(0);
		}
	});
});

describe("runOps", () => {
	it("applies the accepted ops in the batch's order and reports each refused one with its reason", () => {
		const run = runOps(
			stackVocabulary,
			{ items: [] },
			{
				id: "d",
				summary: "s",
				ops: [
					{ op: "pop" },
					{ op: "push", value: "a" },
					{ op: "push", value: "b" },
					{ op: "pop" },
					{ op: "push", value: "c" },
				],
			},
		);
		expect(run.ok).toBe(true);
		if (!run.ok) return;
		expect(run.doc).toEqual({ items: ["a", "c"] });
		expect(run.applied).toBe(4);
		expect(run.accepted.map((op) => op.op)).toEqual([
			"push",
			"push",
			"pop",
			"push",
		]);
		expect(run.refused).toEqual([
			{ index: 0, op: "pop", reason: "empty", detail: "nothing to pop" },
		]);
		expect(run.diffId).toBe("d");
		expect(run.summary).toBe("s");
	});

	it("judges an op against what the ops before it left, not against the document it started from", () => {
		const run = runOps(
			stackVocabulary,
			{ items: ["x", "y", "z"] },
			diff(
				{ op: "push", value: "1" },
				{ op: "pop" },
				{ op: "push", value: "2" },
			),
		);
		if (!run.ok) throw new Error(run.detail);
		expect(run.refused.map((r) => r.index)).toEqual([0]);
		expect(run.doc.items).toEqual(["x", "y", "2"]);
	});

	it("does not mutate the document it was handed", () => {
		const start = Object.freeze({ items: Object.freeze(["a"]) as string[] });
		expect(() =>
			runOps(stackVocabulary, start, diff({ op: "push", value: "b" })),
		).not.toThrow();
		expect(start.items).toEqual(["a"]);
	});

	it("answers invalid_diff, naming the valid ops, for a diff the vocabulary's schema rejects", () => {
		const cases: unknown[] = [
			{ id: "d", summary: "s", ops: [{ op: "shove", value: "a" }] },
			{ id: "d", summary: "s", ops: [{ op: "push" }] },
			{ id: "d", summary: "s", ops: [] },
			{ id: "d", summary: "", ops: [{ op: "pop" }] },
			{ id: "d", summary: "s" },
		];
		for (const raw of cases) {
			const run = runOps(stackVocabulary, { items: [] }, raw);
			expect(run.ok).toBe(false);
			if (run.ok) continue;
			expect(run.reason).toBe("invalid_diff");
			expect(run.detail).toContain("Valid ops: push, pop");
		}
	});

	it("points at the op that is wrong, by its place in the batch", () => {
		const run = runOps(
			stackVocabulary,
			{ items: [] },
			{
				id: "d",
				summary: "s",
				ops: [{ op: "pop" }, { op: "push", value: "" }],
			},
		);
		if (run.ok) throw new Error("expected a refusal");
		expect(run.detail).toContain("ops[1].value");
	});

	it("says an unknown op name is unknown rather than 'invalid input'", () => {
		const run = runOps(
			stackVocabulary,
			{ items: [] },
			{
				id: "d",
				summary: "s",
				ops: [{ op: "shove" }],
			},
		);
		if (run.ok) throw new Error("expected a refusal");
		expect(run.detail).toContain("ops[0].op");
	});

	it("accounts for every op: a vocabulary that loses one is a bug the mechanism refuses to hide", () => {
		const losing: OpsVocabulary<Stack, StackOp, StackReason> = {
			...stackVocabulary,
			validate: (ops) => ({ accepted: ops.slice(1), refused: [] }),
		};
		expect(() =>
			runOps(
				losing,
				{ items: [] },
				diff({ op: "push", value: "a" }, { op: "pop" }),
			),
		).toThrow(/every op/i);
	});

	it("puts refusals in batch order whatever order the vocabulary found them in", () => {
		const backwards: OpsVocabulary<Stack, StackOp, StackReason> = {
			...stackVocabulary,
			validate: (ops) => ({
				accepted: [],
				refused: [...ops]
					.map((op, index) => ({
						index,
						op: op.op,
						reason: "empty" as const,
						detail: "no",
					}))
					.reverse(),
			}),
		};
		const run = runOps(
			backwards,
			{ items: [] },
			diff({ op: "pop" }, { op: "pop" }, { op: "pop" }),
		);
		if (!run.ok) throw new Error(run.detail);
		expect(run.refused.map((r) => r.index)).toEqual([0, 1, 2]);
	});

	it("refuses a vocabulary that names one op twice or an op that is not in the batch", () => {
		const twice: OpsVocabulary<Stack, StackOp, StackReason> = {
			...stackVocabulary,
			validate: (ops) => ({
				accepted: [],
				refused: [
					{ index: 0, op: "pop", reason: "empty", detail: "a" },
					{ index: 0, op: "pop", reason: "empty", detail: "b" },
					...ops.slice(2).map((op, i) => ({
						index: i + 2,
						op: op.op,
						reason: "empty" as const,
						detail: "c",
					})),
				],
			}),
		};
		expect(() =>
			runOps(twice, { items: [] }, diff({ op: "pop" }, { op: "pop" })),
		).toThrow();
		const outOfRange: OpsVocabulary<Stack, StackOp, StackReason> = {
			...stackVocabulary,
			validate: () => ({
				accepted: [],
				refused: [{ index: 7, op: "pop", reason: "empty", detail: "a" }],
			}),
		};
		expect(() =>
			runOps(outOfRange, { items: [] }, diff({ op: "pop" })),
		).toThrow();
	});
});
