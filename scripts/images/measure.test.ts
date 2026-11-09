import { describe, expect, it } from "vitest";
import {
	MEASURE_CASES,
	mineruHealthUrls,
	neighbourHealthUrls,
	parseActiveUnits,
	parseNvidiaSmiSamples,
} from "./measure";

describe("parseActiveUnits", () => {
	it("keeps the units `systemctl is-active` calls active, matched by order", () => {
		expect(
			parseActiveUnits("active\ninactive\n", ["mineru41", "mineru4"]),
		).toEqual(["mineru41"]);
		expect(
			parseActiveUnits("inactive\nactive\n", ["mineru41", "mineru4"]),
		).toEqual(["mineru4"]);
	});
	it("counts a failed, activating or unknown unit, and silence, as not active", () => {
		expect(
			parseActiveUnits("failed\nactivating\n", ["mineru41", "mineru4"]),
		).toEqual([]);
		expect(parseActiveUnits("", ["mineru41", "mineru4"])).toEqual([]);
	});
});

describe("mineruHealthUrls", () => {
	const IN_USE = "http://127.0.0.1:8004/v1/health";
	const ROLLBACK = "http://127.0.0.1:8002/v1/health";
	it("probes MinerU 4.1 on :8004 whatever the units say, so a dead one shows", () => {
		expect(mineruHealthUrls([])).toEqual([IN_USE]);
		expect(mineruHealthUrls(["mineru41"])).toEqual([IN_USE]);
	});
	it("also probes 4.0.12 on :8002 while the rollback unit runs (both run side by side)", () => {
		expect(mineruHealthUrls(["mineru41", "mineru4"])).toEqual([
			IN_USE,
			ROLLBACK,
		]);
	});
	it("does not probe 4.0.12 once its unit is retired, so it never reads as a dead neighbour", () => {
		expect(mineruHealthUrls(["mineru41"])).not.toContain(ROLLBACK);
	});
});

describe("neighbourHealthUrls", () => {
	it("watches TEI, the MinerUs that run, and the MinerU VLM server", () => {
		expect(neighbourHealthUrls(["mineru41", "mineru4"])).toEqual([
			"http://127.0.0.1:7997/health",
			"http://127.0.0.1:7998/health",
			"http://127.0.0.1:8004/v1/health",
			"http://127.0.0.1:8002/v1/health",
			"http://127.0.0.1:30001/health",
		]);
		expect(neighbourHealthUrls(["mineru41"])).toEqual([
			"http://127.0.0.1:7997/health",
			"http://127.0.0.1:7998/health",
			"http://127.0.0.1:8004/v1/health",
			"http://127.0.0.1:30001/health",
		]);
	});
});

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
