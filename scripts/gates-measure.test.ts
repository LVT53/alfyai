import { expect, test } from "vitest";
// @ts-expect-error — plain .mjs script, no type declarations
import * as measure from "./gates-measure.mjs";

const { playwrightTimings, slowestUnitFiles, vitestSplit } = measure;

test("measures file spans, worker tail, and nested sign-in steps", () => {
	const at = (ms: number) => new Date(ms).toISOString();
	const result = (
		start: number,
		duration: number,
		parallelIndex: number,
		steps: object[] = [],
	) => ({
		startTime: at(start),
		duration,
		parallelIndex,
		steps,
	});
	const suite = (file: string, results: object[]) => ({
		file,
		suites: [{ specs: [{ tests: [{ results }] }] }],
	});
	expect(
		playwrightTimings({
			stats: { startTime: at(0) },
			suites: [
				suite("a.spec.ts", [
					result(0, 500, 0, [{ title: "sign in", duration: 300 }]),
					result(1000, 1000, 0),
				]),
				suite("b.spec.ts", [
					result(500, 5000, 1, [
						{
							title: "setup",
							steps: [{ title: "sign in (form)", duration: 900 }],
						},
					]),
				]),
			],
		}),
	).toEqual({
		files: [
			{ file: "b.spec.ts", ms: 5000 },
			{ file: "a.spec.ts", ms: 2000 },
		],
		workers: [
			{ slot: 0, endMs: 2000 },
			{ slot: 1, endMs: 5500 },
		],
		tailMs: 3500,
		signInMs: 1200,
	});
});

test("reads Vitest worker times in mixed units", () => {
	expect(
		vitestSplit(
			"Duration  950ms (transform 120ms, setup 0ms, import 2.1s, tests 1m 3s, environment 0ms)",
		),
	).toEqual({
		transform: 0.12,
		setup: 0,
		import: 2.1,
		tests: 63,
		environment: 0,
	});
	expect(vitestSplit("no duration")).toBeNull();
});

test("ranks unit test files by elapsed time", () => {
	expect(
		slowestUnitFiles(
			{
				testResults: [
					{ name: "a.test.ts", startTime: 1, endTime: 3 },
					{ name: "b.test.ts", startTime: 2, endTime: 10 },
				],
			},
			1,
		),
	).toEqual([{ file: "b.test.ts", ms: 8 }]);
});
