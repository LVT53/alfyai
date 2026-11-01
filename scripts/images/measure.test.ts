import { describe, expect, it } from "vitest";
import { MEASURE_CASES, parseNvidiaSmiSamples } from "./measure";

describe("parseNvidiaSmiSamples", () => {
	it("keeps only the rows of the asked GPU", () => {
		expect(parseNvidiaSmiSamples("0, 1200\n1, 30500\n1, 31877\n", 1)).toEqual([
			30500, 31877,
		]);
	});
	it("skips blank and broken lines", () => {
		expect(parseNvidiaSmiSamples("\nfoo\n1, 5\n1, x\n", 1)).toEqual([5]);
	});
});

describe("MEASURE_CASES", () => {
	const byId = (id: string) => MEASURE_CASES.find((c) => c.id === id);
	it("covers the brief's cases with the canvases canvasForEdit gives", () => {
		expect(byId("generate-cold")).toMatchObject({
			mode: "generate",
			inputs: 0,
			canvas: { width: 1248, height: 832 },
			runs: 1,
		});
		expect(byId("generate-warm")?.runs).toBe(3);
		for (const [id, inputs, runs] of [
			["edit-1", 1, 3],
			["edit-2", 2, 1],
			["edit-4", 4, 1],
		] as const) {
			expect(byId(id)).toMatchObject({
				mode: "edit",
				inputs,
				runs,
				canvas: { width: 1184, height: 896 },
			});
		}
		expect(byId("edit-print")?.canvas.width).toBe(2368);
		expect(byId("trap-1024")?.canvas).toEqual({ width: 1024, height: 1024 });
		expect(byId("trap-same-seed")?.mode).toBe("edit");
		expect(byId("generate-transparent")?.mode).toBe("generate");
		expect(byId("crash")?.mode).toBe("edit");
	});
});
