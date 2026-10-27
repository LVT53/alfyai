import { describe, expect, it } from "vitest";
import { parseTakeRequest, type TakeRequest } from "./take-request";

function request(overrides: Partial<TakeRequest> = {}): TakeRequest {
	return {
		v: 1,
		mode: "generate",
		prompt: "a cosy living room",
		inputs: [],
		baseFromUpload: false,
		canvas: { width: 1248, height: 832 },
		transparent: false,
		avoidSeeds: [],
		anchor: null,
		marks: null,
		title: "Cosy living room",
		summary: null,
		...overrides,
	};
}

describe("parseTakeRequest", () => {
	it("gives back a request that was stringified", () => {
		const original = request({
			mode: "edit",
			inputs: [
				{ fileId: "f1", role: "base", name: "room.png" },
				{ fileId: "f2", role: "reference", name: "sofa.png" },
			],
			baseFromUpload: true,
			avoidSeeds: [7, 9],
			anchor: { fileId: "f0", chainSinceAnchor: 2 },
			marks: [{ letter: "A", x: 0.1, y: 0.1, w: 0.3, h: 0.3 }],
			summary: "Make the sofa green",
		});
		expect(parseTakeRequest(JSON.stringify(original))).toEqual(original);
	});

	it("refuses a generate with inputs", () => {
		const bad = request({
			inputs: [{ fileId: "f1", role: "base", name: "room.png" }],
		});
		expect(parseTakeRequest(JSON.stringify(bad))).toBeNull();
	});

	it("refuses an edit without a base first", () => {
		const none = request({ mode: "edit", inputs: [] });
		expect(parseTakeRequest(JSON.stringify(none))).toBeNull();
		const wrongOrder = request({
			mode: "edit",
			inputs: [
				{ fileId: "f2", role: "reference", name: "sofa.png" },
				{ fileId: "f1", role: "base", name: "room.png" },
			],
		});
		expect(parseTakeRequest(JSON.stringify(wrongOrder))).toBeNull();
	});

	it("refuses a canvas side that is not a multiple of 32", () => {
		const bad = request({ canvas: { width: 1250, height: 832 } });
		expect(parseTakeRequest(JSON.stringify(bad))).toBeNull();
	});

	it("refuses text that is not a request", () => {
		expect(parseTakeRequest("not json")).toBeNull();
		expect(parseTakeRequest("[]")).toBeNull();
		expect(parseTakeRequest(JSON.stringify({ ...request(), v: 2 }))).toBeNull();
		expect(
			parseTakeRequest(JSON.stringify({ ...request(), prompt: "  " })),
		).toBeNull();
	});
});
