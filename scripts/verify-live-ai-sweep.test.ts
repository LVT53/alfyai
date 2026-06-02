import { describe, expect, it } from "vitest";
import {
	aiSdkUiStreamContractMetadata,
	aiSdkUiStreamContractSequence,
	aiSdkUiStreamContractToolCall,
	encodeAiSdkUiFixtureFrame,
	encodeAiSdkUiFixtureFrames,
	oldBrowserSseNamedEndEvent,
	oldBrowserSseNamedTokenEvent,
} from "../tests/fixtures/ai-sdk-ui-stream-contract";
import {
	getMissingStandardRecallNeedles,
	parseJsonObject,
	parseLiveAiSweepStreamFrames,
	structuredRecallHasValue,
} from "./verify-live-ai-sweep";

function standardRecallJson(
	overrides: Partial<Record<string, string>> = {},
): string {
	return JSON.stringify({
		cycle1_codename: "LANTERN-PAPAYA-17",
		cycle1_person: "Inez Vale",
		cycle1_budget_checksum: "18742.60",
		cycle1_folder: "teal folder marked 9Q",
		cycle1_appointment: "2026-06-18 14:30 Europe/Budapest",
		cycle1_handoff: "North pier C-17",
		cycle2_codename: "RIVER-ONYX-41",
		cycle2_audit_lead: "Tomasz Grell",
		cycle2_invoice_crumb: "VX-4409",
		cycle2_fallback_address: "Selyem utca 14, gate B",
		cycle2_mural_count: "11 triangles",
		cycle3_codename: "ORCHID-TUNGSTEN-58",
		cycle3_owner: "Priya Sen",
		cycle3_bridge: "Híd-3",
		cycle3_branch: "release/saffron-needle",
		cycle3_blocker: "thermal label printer jams after 42 labels",
		cycle3_crate_code: "M-77",
		...overrides,
	});
}

describe("live AI sweep structured recall validation", () => {
	it("rejects non-JSON recall output even when prose includes an expected value", () => {
		const text = 'The strict JSON is {"reviewer":"Kende Farkas"}.';
		const parsed = parseJsonObject(text);

		expect(parsed).toBeNull();
		expect(
			structuredRecallHasValue({
				parsed,
				field: "reviewer",
				acceptedValues: ["Kende Farkas"],
			}),
		).toBe(false);
	});

	it("rejects expected recall values found only in the wrong JSON field", () => {
		const parsed = parseJsonObject(
			JSON.stringify({
				notes: "The reviewer is Kende Farkas.",
				reviewer: "Mira Kovacs",
			}),
		);

		expect(
			structuredRecallHasValue({
				parsed,
				field: "reviewer",
				acceptedValues: ["Kende Farkas"],
			}),
		).toBe(false);
	});

	it("rejects negated prose in the expected JSON field", () => {
		const parsed = parseJsonObject(
			JSON.stringify({ reviewer: "Not Kende Farkas" }),
		);

		expect(
			structuredRecallHasValue({
				parsed,
				field: "reviewer",
				acceptedValues: ["Kende Farkas"],
			}),
		).toBe(false);
	});

	it("rejects numeric count overmatches in the expected JSON field", () => {
		const parsed = parseJsonObject(
			JSON.stringify({ cycle2_mural_count: "110 triangles" }),
		);

		expect(
			structuredRecallHasValue({
				parsed,
				field: "cycle2_mural_count",
				acceptedValues: ["11 triangles", "11"],
			}),
		).toBe(false);
	});

	it("accepts configured aliases only when they match the parsed field value", () => {
		const parsed = parseJsonObject(JSON.stringify({ envelope: "envelope 6F" }));

		expect(
			structuredRecallHasValue({
				parsed,
				field: "envelope",
				acceptedValues: ["6F", "envelope 6F"],
			}),
		).toBe(true);
	});

	it("rejects standard post-compaction recall prose even when all values are present", () => {
		const prose =
			"LANTERN-PAPAYA-17, Inez Vale, 18742.60, teal folder marked 9Q, 2026-06-18 14:30 Europe/Budapest, North pier C-17, RIVER-ONYX-41, Tomasz Grell, VX-4409, Selyem utca 14, gate B, 11 triangles, ORCHID-TUNGSTEN-58, Priya Sen, Híd-3, release/saffron-needle, thermal label printer jams after 42 labels, and M-77.";

		expect(getMissingStandardRecallNeedles(prose)).toEqual([
			"LANTERN-PAPAYA-17",
			"Inez Vale",
			"18742.60",
			"teal folder marked 9Q",
			"2026-06-18 14:30 Europe/Budapest",
			"North pier C-17",
			"RIVER-ONYX-41",
			"Tomasz Grell",
			"VX-4409",
			"Selyem utca 14, gate B",
			"11 triangles",
			"ORCHID-TUNGSTEN-58",
			"Priya Sen",
			"Híd-3",
			"release/saffron-needle",
			"thermal label printer jams after 42 labels",
			"M-77",
		]);
	});

	it("accepts a full fenced JSON object without accepting surrounding prose", () => {
		expect(
			getMissingStandardRecallNeedles(
				["```json", standardRecallJson(), "```"].join("\n"),
			),
		).toEqual([]);

		expect(
			parseJsonObject(["Here is the JSON:", "```json", "{}", "```"].join("\n")),
		).toBeNull();
	});

	it("rejects standard post-compaction recall values found only in the wrong JSON field", () => {
		expect(
			getMissingStandardRecallNeedles(
				standardRecallJson({
					cycle1_person: "Mira Kovacs",
					notes: "Inez Vale appears in prose, not the requested field.",
				}),
			),
		).toEqual(["Inez Vale"]);
	});

	it("accepts standard post-compaction recall values in the expected JSON fields", () => {
		expect(getMissingStandardRecallNeedles(standardRecallJson())).toEqual([]);
	});
});

describe("live AI sweep stream parser", () => {
	it("accepts current AI SDK UI stream data frames", () => {
		const result = parseLiveAiSweepStreamFrames(
			encodeAiSdkUiFixtureFrames(aiSdkUiStreamContractSequence),
		);

		expect(result.text).toBe("Hello world");
		expect(result.thinkingLength).toBe("Need current evidence.".length);
		expect(result.metadata).toEqual(aiSdkUiStreamContractMetadata);
		expect(result.toolCalls).toEqual([aiSdkUiStreamContractToolCall]);
	});

	it("ignores named old Browser SSE events", () => {
		const result = parseLiveAiSweepStreamFrames([
			oldBrowserSseNamedTokenEvent,
			oldBrowserSseNamedEndEvent,
		]);

		expect(result.text).toBe("");
		expect(result.thinkingLength).toBe(0);
		expect(result.metadata).toBeNull();
		expect(result.toolCalls).toEqual([]);
	});

	it("collects current AI SDK UI stream errors and terminal finish parts", () => {
		const result = parseLiveAiSweepStreamFrames([
			encodeAiSdkUiFixtureFrame({
				type: "data-stream-error",
				data: { message: "provider failed", code: "upstream_error" },
				transient: true,
			}),
			encodeAiSdkUiFixtureFrame({
				type: "error",
				errorText: "model run failed",
			}),
			encodeAiSdkUiFixtureFrame({
				type: "finish",
				finishReason: "error",
				error: "finished with error",
			}),
			encodeAiSdkUiFixtureFrame("[DONE]"),
		]);

		expect(result.errors).toEqual([
			"provider failed",
			"model run failed",
			"finished with error",
		]);
		expect(result.finish).toEqual({
			type: "finish",
			finishReason: "error",
			error: "finished with error",
		});
	});
});
