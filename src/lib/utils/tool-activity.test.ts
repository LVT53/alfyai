import { get } from "svelte/store";
import { describe, expect, it } from "vitest";
import { t } from "$lib/i18n";
import type { FileProductionJob } from "$lib/server/services/file-production/types";
import {
	buildConnectorActivityItem,
	buildFileProductionActivityItem,
	buildToolActivityItem,
	buildToolActivitySummary,
	runPythonObject,
	toolElapsedLabel,
	toolFailureReason,
} from "./tool-activity";
import type { ToolCallSegment } from "./tool-evidence-presentation";

// The real English dictionary, so these assert the copy a user actually sees
// rather than a stand-in — the row grammar IS the thing under test.
const translate = get(t);

function toolCall(overrides: Partial<ToolCallSegment>): ToolCallSegment {
	return {
		type: "tool_call",
		name: "research_web",
		input: {},
		status: "done",
		...overrides,
	} as ToolCallSegment;
}

describe("tool activity row grammar", () => {
	it("reads a web search as 'Searched <query>' with a source count on the right", () => {
		const item = buildToolActivityItem(
			toolCall({
				name: "research_web",
				input: { query: "cork weather 12–13 september" },
				candidates: [
					{
						id: "c1",
						title: "Cork city forecast",
						url: "https://met.ie/cork",
						sourceType: "web",
						status: "selected",
					},
					{
						id: "c2",
						title: "Cork 10-day weather",
						url: "https://yr.no/cork",
						sourceType: "web",
					},
				],
			} as Partial<ToolCallSegment>),
			"k1",
			translate,
		);

		expect(item.verb).toBe("Searched");
		expect(item.object).toBe("cork weather 12–13 september");
		expect(item.meta).toBe("2 sources");
		expect(item.iconType).toBe("web-search");
		expect(item.body).toMatchObject({ kind: "sources", citedCount: 1 });
	});

	it("uses the present tense while a tool is still running", () => {
		const item = buildToolActivityItem(
			toolCall({ input: { query: "cork weather" }, status: "running" }),
			"k1",
			translate,
		);
		expect(item.verb).toBe("Searching");
	});

	it("reads a page read as 'Read <host · title>' from the call's own candidate", () => {
		const item = buildToolActivityItem(
			toolCall({
				name: "fetch_url",
				input: { url: "https://www.met.ie/cork-city" },
				candidates: [
					{
						id: "c1",
						title: "Cork city forecast",
						url: "https://www.met.ie/cork-city",
						sourceType: "web",
						snippet: "Saturday: wet and windy…",
					},
				],
			} as Partial<ToolCallSegment>),
			"k2",
			translate,
		);

		expect(item.verb).toBe("Read");
		expect(item.object).toBe("met.ie · Cork city forecast");
		expect(item.iconType).toBe("fetch-url");
		expect(item.body).toMatchObject({
			kind: "page",
			excerpt: "Saturday: wet and windy…",
		});
	});

	it("falls back to the bare host when a read has no candidate title", () => {
		const item = buildToolActivityItem(
			toolCall({ name: "fetch_url", input: { url: "https://example.com/a" } }),
			"k3",
			translate,
		);
		expect(item.object).toBe("example.com");
	});

	it("reads a Python run as 'Ran Python <first comment>' and puts the program in the body", () => {
		const item = buildToolActivityItem(
			toolCall({
				name: "run_python",
				input: { code: "# day count and distance check\nprint(1)" },
				outputSummary: "7\n34",
			}),
			"k4",
			translate,
		);

		expect(item.verb).toBe("Ran Python");
		expect(item.object).toBe("day count and distance check");
		expect(item.iconType).toBe("run-python");
		expect(item.body).toMatchObject({ kind: "python", output: "7\n34" });
	});

	it("falls back to a neutral 'scratch program' when the code carries no leading comment", () => {
		expect(runPythonObject({ code: "print(1)\n# later" }, translate)).toBe(
			"scratch program",
		);
	});

	it("reads a route as 'Route <A → B>' with distance · duration, and pins it as a deliverable", () => {
		const item = buildToolActivityItem(
			toolCall({
				name: "map_route",
				input: { action: "route" },
				map: {
					bounds: { minLat: 51, minLng: -8.6, maxLat: 51.9, maxLng: -8.3 },
					distanceM: 27_000,
					durationS: 2040,
					originLabel: "Cork",
					destinationLabel: "Kinsale",
					attribution: "© OpenStreetMap contributors",
				},
			} as Partial<ToolCallSegment>),
			"k5",
			translate,
		);

		expect(item.verb).toBe("Route");
		expect(item.object).toBe("Cork → Kinsale");
		expect(item.meta).toBe("27.0 km · 34 min");
		expect(item.iconType).toBe("map-route");
		expect(item.pinned).toBe(true);
		expect(item.body).toMatchObject({ kind: "map" });
	});

	it("reads a transit journey as 'Transit <A → B>' with duration · transfers", () => {
		const item = buildToolActivityItem(
			toolCall({
				name: "map_route",
				input: { action: "transit" },
				map: {
					bounds: { minLat: 49.3, minLng: 8.6, maxLat: 49.5, maxLng: 8.8 },
					// Distance is deliberately present but NOT shown: nobody asks how
					// many kilometres a bus ride is.
					distanceM: 5231,
					durationS: 4320,
					mode: "transit",
					transfers: 1,
					originLabel: "Dossenheim",
					destinationLabel: "Heidelberg",
					transitLegs: [
						{ type: "walk", minutes: 3 },
						{ type: "pt", line: "39A", minutes: 19, stops: 7 },
					],
					attribution: "© OpenStreetMap contributors",
				},
			} as Partial<ToolCallSegment>),
			"k5b",
			translate,
		);

		expect(item.verb).toBe("Transit");
		expect(item.object).toBe("Dossenheim → Heidelberg");
		expect(item.meta).toBe("1 h 12 min · 1 transfer");
		expect(item.iconType).toBe("map-route");
		expect(item.pinned).toBe(true);
		expect(item.body).toMatchObject({ kind: "map" });
	});

	it("pluralizes the transfer count", () => {
		const item = buildToolActivityItem(
			toolCall({
				name: "map_route",
				input: { action: "transit" },
				map: {
					bounds: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
					durationS: 1800,
					mode: "transit",
					transfers: 2,
					originLabel: "A",
					destinationLabel: "B",
					attribution: "© OpenStreetMap contributors",
				},
			} as Partial<ToolCallSegment>),
			"k5c",
			translate,
		);
		expect(item.meta).toBe("30 min · 2 transfers");
	});

	it("reads a timetable as 'Timetable <A → B>' counting the departures", () => {
		const item = buildToolActivityItem(
			toolCall({
				name: "map_route",
				input: { action: "timetable" },
				map: {
					bounds: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
					durationS: 1620,
					mode: "transit",
					transfers: 1,
					originLabel: "Dossenheim",
					destinationLabel: "Heidelberg",
					departures: Array.from({ length: 6 }, (_, index) => ({
						depart: `08:${String(index * 10).padStart(2, "0")}`,
						minutes: 27,
						transfers: 1,
					})),
					attribution: "© OpenStreetMap contributors",
				},
			} as Partial<ToolCallSegment>),
			"k5d",
			translate,
		);

		expect(item.verb).toBe("Timetable");
		expect(item.object).toBe("Dossenheim → Heidelberg");
		expect(item.meta).toBe("6 departures");
		expect(item.body).toMatchObject({ kind: "map" });
		expect(item.body?.kind === "map" ? item.body.summary : "").toBe(
			"Dossenheim → Heidelberg · 6 departures",
		);
	});

	it("keeps the road-route grammar for the plain route action", () => {
		const item = buildToolActivityItem(
			toolCall({
				name: "map_route",
				input: { action: "route" },
				map: {
					bounds: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
					distanceM: 27_000,
					durationS: 2040,
					transfers: 1,
					originLabel: "Cork",
					destinationLabel: "Kinsale",
					attribution: "© OpenStreetMap contributors",
				},
			} as Partial<ToolCallSegment>),
			"k5e",
			translate,
		);
		// A stray `transfers` on a road card must not leak into the meta line.
		expect(item.verb).toBe("Route");
		expect(item.meta).toBe("27.0 km · 34 min");
	});

	it("shows the running verbs while a transit call is still in flight", () => {
		expect(
			buildToolActivityItem(
				toolCall({
					name: "map_route",
					input: { action: "transit" },
					status: "running",
				}),
				"k5f",
				translate,
			).verb,
		).toBe("Planning transit");
		expect(
			buildToolActivityItem(
				toolCall({
					name: "map_route",
					input: { action: "timetable" },
					status: "running",
				}),
				"k5g",
				translate,
			).verb,
		).toBe("Loading timetable");
	});

	it("reads a skill load as 'Used skill <name>' from the call's own metadata", () => {
		const item = buildToolActivityItem(
			toolCall({
				name: "use_skill",
				input: { name: "purchase-helper" },
				metadata: { skillDisplayName: "Purchase Helper" },
				outputSummary: 'Loaded skill "Purchase Helper"',
			}),
			"k6",
			translate,
		);

		expect(item.verb).toBe("Used skill");
		expect(item.object).toBe("Purchase Helper");
		expect(item.iconType).toBe("use-skill");
		expect(item.body).toMatchObject({ kind: "text" });
	});

	it("reads a memory lookup as 'Recalled N memories' with the memories as bullets", () => {
		const item = buildToolActivityItem(
			toolCall({
				name: "memory_context",
				input: { query: "packing" },
				candidates: [
					{ id: "m1", title: "Prefers Celsius", sourceType: "memory" },
					{ id: "m2", title: "Travels with a toddler", sourceType: "memory" },
				],
			} as Partial<ToolCallSegment>),
			"k7",
			translate,
		);

		expect(item.verb).toBe("Recalled");
		expect(item.object).toBe("2 memories");
		expect(item.iconType).toBe("memory");
		expect(item.body).toMatchObject({
			kind: "bullets",
			items: ["Prefers Celsius", "Travels with a toddler"],
		});
	});

	it("singularizes a single recalled memory", () => {
		const item = buildToolActivityItem(
			toolCall({
				name: "memory_context",
				input: {},
				candidates: [
					{ id: "m1", title: "Prefers Celsius", sourceType: "memory" },
				],
			} as Partial<ToolCallSegment>),
			"k7b",
			translate,
		);
		expect(item.object).toBe("1 memory");
	});

	it("reads a connector run as '<Capability> <N actions>' with one body row per action", () => {
		const tools = [
			toolCall({ name: "calendar", input: { action: "list_events" } }),
			toolCall({ name: "calendar", input: { action: "find_free_slots" } }),
		];
		const item = buildConnectorActivityItem(tools, "group-1", translate);

		expect(item.verb).toBe("Calendar");
		expect(item.object).toBe("2 actions");
		expect(item.iconType).toBe("calendar");
		expect(item.body).toMatchObject({
			kind: "actions",
			actions: [
				{ label: "list events", status: "done" },
				{ label: "find free slots", status: "done" },
			],
		});
	});

	it("marks a connector group failed when any call in it failed", () => {
		const item = buildConnectorActivityItem(
			[
				toolCall({ name: "calendar", input: { action: "list_events" } }),
				toolCall({
					name: "calendar",
					input: { action: "create_event" },
					status: "failed",
				}),
			],
			"group-2",
			translate,
		);
		expect(item.status).toBe("failed");
		expect(item.meta).toBe("Failed");
	});

	it("keeps the normal label on a failed row — only the right-hand word says Failed, and the body carries the reason", () => {
		const item = buildToolActivityItem(
			toolCall({
				name: "fetch_url",
				input: { url: "https://weather.metoffice.gov.uk" },
				status: "failed",
				metadata: { error: "request timed out after 20 s" },
			}),
			"k8",
			translate,
		);

		expect(item.meta).toBe("Failed");
		expect(item.object).toContain("weather.metoffice.gov.uk");
		expect(item.body).toEqual({
			kind: "error",
			reason: "request timed out after 20 s",
		});
	});

	it("prefers a structured error over the output summary, and stays silent when neither exists", () => {
		expect(
			toolFailureReason({
				outputSummary: "fallback",
				metadata: { error: "real" },
			}),
		).toBe("real");
		expect(toolFailureReason({ outputSummary: "fallback" })).toBe("fallback");
		expect(toolFailureReason({})).toBeNull();
	});

	it("falls back to the tool's own label and an arguments/result panel for an unknown tool", () => {
		const item = buildToolActivityItem(
			toolCall({
				name: "some_new_tool",
				input: { thing: "value" },
				outputSummary: "it worked",
			}),
			"k9",
			translate,
		);

		expect(item.verb).toBe("Tool");
		expect(item.object).toBe("value");
		expect(item.iconType).toBe("generic");
		expect(item.body).toMatchObject({
			kind: "generic",
			args: [{ key: "thing", value: "value" }],
			result: "it worked",
		});
	});

	it("gives a row with nothing to reveal no body at all (never falsely clickable)", () => {
		const item = buildToolActivityItem(
			toolCall({ name: "some_new_tool", input: {} }),
			"k10",
			translate,
		);
		expect(item.body).toBeNull();
	});

	it("omits an elapsed time unless the segment honestly carries one", () => {
		expect(toolElapsedLabel(undefined)).toBeNull();
		expect(toolElapsedLabel({ ok: true })).toBeNull();
		expect(toolElapsedLabel({ durationMs: 1800 })).toBe("1.8 s");
		expect(toolElapsedLabel({ durationMs: 420 })).toBe("420 ms");
		expect(toolElapsedLabel({ durationMs: 21_400 })).toBe("21 s");
	});
});

describe("file production activity rows", () => {
	function job(overrides: Partial<FileProductionJob> = {}): FileProductionJob {
		return {
			id: "job-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			title: "Cork weekend packing list",
			status: "succeeded",
			stage: null,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			files: [
				{
					id: "file-1",
					filename: "Cork weekend packing list.xlsx",
					mimeType:
						"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
					sizeBytes: 12_288,
					downloadUrl: "/d",
					previewUrl: "/p",
					versionNumber: 1,
				},
			],
			warnings: [],
			dismissed: false,
			error: null,
			...overrides,
		} as FileProductionJob;
	}

	it("reads a produced file as 'Created <filename>' with its size, pinned as a deliverable", () => {
		const item = buildFileProductionActivityItem(job(), translate);
		expect(item.verb).toBe("Created");
		expect(item.object).toBe("Cork weekend packing list.xlsx");
		expect(item.meta).toBe("12 KB");
		expect(item.pinned).toBe(true);
		expect(item.alwaysOpen).toBe(false);
	});

	it("keeps a producing job's row open on its own so the row and body read as one element", () => {
		const item = buildFileProductionActivityItem(
			job({ status: "running", files: [] }),
			translate,
		);
		expect(item.status).toBe("running");
		expect(item.verb).toBe("Creating");
		expect(item.object).toBe("Cork weekend packing list");
		expect(item.alwaysOpen).toBe(true);
	});

	it("maps a failed job onto the failed row + reason body", () => {
		const item = buildFileProductionActivityItem(
			job({ status: "failed", files: [] }),
			translate,
		);
		expect(item.status).toBe("failed");
		expect(item.meta).toBe("Failed");
		expect(item.alwaysOpen).toBe(false);
	});
});

describe("collapsed summary strip", () => {
	it("keeps one short label per tool and folds repeated reads into one 'Read N pages'", () => {
		const items = [
			buildToolActivityItem(
				toolCall({ input: { query: "cork weather" } }),
				"a",
				translate,
			),
			buildToolActivityItem(
				toolCall({ name: "fetch_url", input: { url: "https://met.ie" } }),
				"b",
				translate,
			),
			buildToolActivityItem(
				toolCall({
					name: "fetch_url",
					input: { url: "https://metoffice.gov.uk" },
				}),
				"c",
				translate,
			),
			buildToolActivityItem(
				toolCall({ name: "run_python", input: { code: "print(1)" } }),
				"d",
				translate,
			),
		];

		expect(buildToolActivitySummary(items, translate)).toEqual([
			{ key: "a", iconType: "web-search", label: "Searched" },
			{ key: "b", iconType: "fetch-url", label: "Read 2 pages" },
			{ key: "d", iconType: "run-python", label: "Ran Python" },
		]);
	});

	function search(
		key: string,
		query: string,
		sources: string[],
		overrides: Partial<ToolCallSegment> = {},
	) {
		return buildToolActivityItem(
			toolCall({
				input: { query },
				candidates: sources.map((url, index) => ({
					id: `${key}-${index}`,
					title: url,
					url,
					sourceType: "web",
				})),
				...overrides,
			} as Partial<ToolCallSegment>),
			key,
			translate,
		);
	}

	// The owner's report: the strip listed every call one by one, so a turn
	// that searched three times said "Searched 5 sources · Searched 4 sources
	// · Searched 5 sources". Repeats of one tool now aggregate.
	it("aggregates repeated searches into one entry with the calls and the sources summed", () => {
		const items = [
			search("s1", "cork weather", ["https://met.ie", "https://yr.no"]),
			search("s2", "cork tides", ["https://tides.ie"]),
			search("s3", "cork events", ["https://events.ie", "https://what.ie"]),
		];

		expect(buildToolActivitySummary(items, translate)).toEqual([
			{
				key: "s1",
				iconType: "web-search",
				label: "Searched 3 times · 5 sources",
			},
		]);
	});

	it("says only how often it searched when the searches returned no sources", () => {
		const items = [search("s1", "cork weather", []), search("s2", "tides", [])];

		expect(buildToolActivitySummary(items, translate)[0].label).toBe(
			"Searched 2 times",
		);
	});

	it("aggregates non-adjacent reads, not just consecutive ones", () => {
		const read = (key: string, url: string) =>
			buildToolActivityItem(
				toolCall({ name: "fetch_url", input: { url } }),
				key,
				translate,
			);
		const items = [
			read("r1", "https://met.ie"),
			search("s1", "cork tides", ["https://tides.ie"]),
			read("r2", "https://yr.no"),
			read("r3", "https://metoffice.gov.uk"),
			read("r4", "https://windy.com"),
		];

		expect(buildToolActivitySummary(items, translate)).toEqual([
			{ key: "r1", iconType: "fetch-url", label: "Read 4 pages" },
			{ key: "s1", iconType: "web-search", label: "Searched 1 source" },
		]);
	});

	it("counts repeats of an uncountable tool with a multiplier", () => {
		const python = (key: string, code: string) =>
			buildToolActivityItem(
				toolCall({ name: "run_python", input: { code } }),
				key,
				translate,
			);

		expect(
			buildToolActivitySummary(
				[python("p1", "print(1)"), python("p2", "print(2)")],
				translate,
			),
		).toEqual([{ key: "p1", iconType: "run-python", label: "Ran Python ×2" }]);
	});

	it("sums the actions of several connector groups for one capability", () => {
		const items = [
			buildConnectorActivityItem(
				[
					toolCall({ name: "calendar", input: { action: "list_events" } }),
					toolCall({ name: "calendar", input: { action: "find_free_slots" } }),
				],
				"g1",
				translate,
			),
			buildConnectorActivityItem(
				[
					toolCall({ name: "calendar", input: { action: "create_event" } }),
					toolCall({ name: "calendar", input: { action: "invite" } }),
					toolCall({ name: "calendar", input: { action: "notify" } }),
				],
				"g2",
				translate,
			),
		];

		expect(buildToolActivitySummary(items, translate)).toEqual([
			{ key: "g1", iconType: "calendar", label: "Calendar 5 actions" },
		]);
	});

	it("folds several recalls into a count-less 'Recalled memories'", () => {
		const recall = (key: string, titles: string[]) =>
			buildToolActivityItem(
				toolCall({
					name: "memory_context",
					input: { query: "trip" },
					candidates: titles.map((title, index) => ({
						id: `${key}-${index}`,
						title,
						sourceType: "memory",
					})),
				} as Partial<ToolCallSegment>),
				key,
				translate,
			);
		const items = [recall("m1", ["Likes trains"]), recall("m2", ["Cork trip"])];

		const summary = buildToolActivitySummary(items, translate);
		expect(summary).toHaveLength(1);
		expect(summary[0].label).toBe("Recalled memories");
	});

	it("keeps failures in their own aggregate beside the successes of the same tool", () => {
		const read = (key: string, url: string, failed = false) =>
			buildToolActivityItem(
				toolCall({
					name: "fetch_url",
					input: { url },
					status: failed ? "failed" : "done",
				}),
				key,
				translate,
			);
		const items = [
			read("r1", "https://met.ie"),
			read("f1", "https://blocked.example", true),
			read("r2", "https://yr.no"),
			read("f2", "https://timeout.example", true),
		];

		expect(buildToolActivitySummary(items, translate)).toEqual([
			{ key: "r1", iconType: "fetch-url", label: "Read 2 pages" },
			{ key: "f1", iconType: "fetch-url", label: "Read 2 failed" },
		]);
	});

	it("keeps every entry in the order its tool first appeared", () => {
		const items = [
			buildToolActivityItem(
				toolCall({ name: "run_python", input: { code: "print(1)" } }),
				"p1",
				translate,
			),
			search("s1", "cork weather", ["https://met.ie"]),
			buildToolActivityItem(
				toolCall({ name: "run_python", input: { code: "print(2)" } }),
				"p2",
				translate,
			),
		];

		expect(
			buildToolActivitySummary(items, translate).map((entry) => entry.key),
		).toEqual(["p1", "s1"]);
	});
});

describe("buildToolActivityItem — journey row", () => {
	it("reads a mixed-mode journey as its time and the modes it uses", () => {
		const item = buildToolActivityItem(
			toolCall({
				name: "map_route",
				input: { action: "journey" },
				map: {
					bounds: { minLat: 51, minLng: -9, maxLat: 54, maxLng: -6 },
					durationS: 12_720,
					mode: "journey",
					originLabel: "Cork, Blackrock",
					destinationLabel: "Trinity College Dublin",
					transitLegs: [
						{ type: "bike", minutes: 16 },
						{ type: "pt", minutes: 157, line: "IC" },
						{ type: "walk", minutes: 10 },
						{ type: "walk", minutes: 8 },
					],
					attribution: "© OpenStreetMap contributors",
				},
			} as Partial<ToolCallSegment>),
			"k-journey",
			translate,
		);
		expect(item.verb).toBe("Journey");
		expect(item.object).toBe("Cork, Blackrock → Trinity College Dublin");
		// Modes in the order they are travelled, each named once.
		expect(item.meta).toBe("3 h 32 min · bike, transit, walk");
		expect(item.body?.kind).toBe("map");
	});

	it("shows the running verb while a journey is still being planned", () => {
		expect(
			buildToolActivityItem(
				toolCall({
					name: "map_route",
					input: { action: "journey" },
					status: "running",
				}),
				"k-journey-running",
				translate,
			).verb,
		).toBe("Planning journey");
	});
});
