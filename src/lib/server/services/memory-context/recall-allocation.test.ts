import { describe, expect, it } from "vitest";
import { allocateRecall, type RecallCandidate } from "./recall-allocation";

const run = (prefix: string, n: number, tokens = 10) =>
	Array.from({ length: n }, (_, i) => ({ key: `${prefix}${i}`, tokens }));
const lane = (capTokens: number, ...lists: RecallCandidate[][]) => ({
	lists,
	capTokens,
});

describe("allocateRecall", () => {
	it("keeps a project's share even when the person's entries alone would fill the budget", () => {
		expect(
			allocateRecall(
				[
					lane(50, run("j", 10)),
					lane(25, run("c", 10)),
					lane(100, run("m", 10)),
				],
				100,
			),
		).toEqual(["j0", "j1", "j2", "j3", "j4", "c0", "c1", "m0", "m1", "m2"]);
	});

	it("passes an unused project share on", () => {
		expect(
			allocateRecall(
				[
					lane(50, run("j", 1)),
					lane(25, run("c", 10)),
					lane(100, run("m", 10)),
				],
				100,
			),
		).toEqual(["j0", "c0", "c1", "m0", "m1", "m2", "m3", "m4", "m5", "m6"]);
	});

	it("takes an entry that two searches found once", () => {
		const a = { key: "a", tokens: 10 };
		const b = { key: "b", tokens: 10 };
		const c = { key: "c", tokens: 10 };
		expect(allocateRecall([lane(100, [a, b]), lane(100, [b, c])], 100)).toEqual(
			["a", "b", "c"],
		);
	});

	it("takes from a lane's lists in turn, past what another lane took", () => {
		expect(
			allocateRecall(
				[lane(40, run("j", 10)), lane(100, run("p", 10), run("j", 10))],
				100,
			),
		).toEqual(["j0", "j1", "j2", "j3", "p0", "j4", "p1", "j5", "p2", "j6"]);
	});

	it("places an entry too large for its lane in the spill pass", () => {
		expect(
			allocateRecall(
				[
					lane(50, [
						{ key: "big", tokens: 60 },
						{ key: "j1", tokens: 10 },
					]),
					lane(25, []),
					lane(100, [{ key: "m0", tokens: 10 }]),
				],
				100,
			),
		).toEqual(["j1", "m0", "big"]);
	});

	it("never goes over the budget", () => {
		const lanes = [
			lane(60, run("j", 7, 13)),
			lane(30, run("c", 7, 17)),
			lane(100, run("m", 7, 23), run("j", 7, 13)),
		];
		const tokens = new Map(
			lanes.flatMap((l) =>
				l.lists.flat().map((c) => [c.key, c.tokens] as const),
			),
		);
		expect(
			allocateRecall(lanes, 100).reduce(
				(sum, key) => sum + (tokens.get(key) ?? 0),
				0,
			),
		).toBeLessThanOrEqual(100);
	});

	it("takes nothing from a zero budget", () => {
		expect(allocateRecall([lane(100, run("m", 3))], 0)).toEqual([]);
	});
});
