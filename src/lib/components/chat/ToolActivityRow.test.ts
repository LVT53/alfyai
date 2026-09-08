import { readFileSync } from "node:fs";
import { fireEvent, render } from "@testing-library/svelte";
import { get } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "$lib/i18n";
import { uiLanguage } from "$lib/stores/settings";
import {
	buildConnectorActivityItem,
	buildToolActivityItem,
	type ToolActivityItem,
} from "$lib/utils/tool-activity";
import type { ToolCallSegment } from "$lib/utils/tool-evidence-presentation";
import ToolActivityRow from "./ToolActivityRow.svelte";

function toolCall(overrides: Partial<ToolCallSegment>): ToolCallSegment {
	return {
		type: "tool_call",
		name: "research_web",
		input: {},
		status: "done",
		...overrides,
	} as ToolCallSegment;
}

function item(
	overrides: Partial<ToolCallSegment>,
	key = "row-1",
): ToolActivityItem {
	return buildToolActivityItem(toolCall(overrides), key, get(t));
}

const searchSegment: Partial<ToolCallSegment> = {
	name: "research_web",
	input: { query: "cork weather" },
	candidates: [
		{
			id: "c1",
			title: "Cork city forecast",
			url: "https://met.ie/cork",
			sourceType: "web",
			status: "selected",
			snippet: "Saturday: wet and windy…",
		},
	] as ToolCallSegment["candidates"],
};

describe("ToolActivityRow", () => {
	beforeEach(() => {
		uiLanguage.set("en");
	});

	it("renders the row anatomy: status glyph, tool icon, verb, object and right-hand meta", () => {
		const { getByTestId } = render(ToolActivityRow, {
			item: item(searchSegment),
		});

		const row = getByTestId("tool-activity-row");
		expect(row.dataset.status).toBe("done");
		expect(row.dataset.iconType).toBe("web-search");
		expect(row.querySelector(".act-status")).not.toBeNull();
		expect(row.querySelector('[data-tool-icon="web-search"]')).not.toBeNull();
		expect(row.querySelector(".act-verb")?.textContent).toBe("Searched");
		expect(row.querySelector(".act-object")?.textContent).toBe("cork weather");
		expect(row.querySelector(".act-meta")?.textContent).toBe("1 source");
	});

	it("marks a running row so its spinner and live verb sweep can play", () => {
		const { getByTestId } = render(ToolActivityRow, {
			item: item({ ...searchSegment, status: "running" }),
		});
		const row = getByTestId("tool-activity-row");
		expect(row.classList.contains("is-running")).toBe(true);
		expect(row.querySelector(".act-status.running")).not.toBeNull();
	});

	it("shows a failed row with the danger word and the reason in its body, keeping the normal label", () => {
		const { getByTestId, getByText } = render(ToolActivityRow, {
			item: item({
				name: "fetch_url",
				input: { url: "https://weather.metoffice.gov.uk" },
				status: "failed",
				metadata: { error: "request timed out after 20 s" },
			}),
			open: true,
		});

		const row = getByTestId("tool-activity-row");
		expect(row.classList.contains("is-failed")).toBe(true);
		expect(row.querySelector(".act-status.failed")).not.toBeNull();
		expect(row.querySelector(".act-meta")?.textContent).toBe("Failed");
		// The label is the one a SUCCESSFUL read would have had — only the
		// glyph and the right-hand word change.
		expect(row.querySelector(".act-verb")?.textContent).toBe("Read");
		expect(row.querySelector(".act-object")?.textContent).toBe(
			"weather.metoffice.gov.uk",
		);
		expect(getByTestId("tool-activity-error")).toBeInTheDocument();
		expect(getByText("request timed out after 20 s")).toBeInTheDocument();
	});

	it("is a button with a chevron only when it has a body, and toggles that body on click", async () => {
		const onToggle = vi.fn();
		const { getByTestId, queryByTestId, rerender } = render(ToolActivityRow, {
			item: item(searchSegment),
			open: false,
			onToggle,
		});

		const row = getByTestId("tool-activity-row");
		expect(row.tagName.toLowerCase()).toBe("button");
		expect(row.getAttribute("aria-expanded")).toBe("false");
		expect(row.querySelector(".act-chevron")).not.toBeNull();
		expect(queryByTestId("tool-activity-body")).toBeNull();

		await fireEvent.click(row);
		expect(onToggle).toHaveBeenCalledWith("row-1");

		// The open state is owned by the caller, so re-render with it applied:
		// the body appears and the row squares off its bottom corners (is-open),
		// which is what visually joins the two into one block.
		await rerender({ item: item(searchSegment), open: true, onToggle });
		const openRow = getByTestId("tool-activity-row");
		expect(openRow.getAttribute("aria-expanded")).toBe("true");
		expect(openRow.classList.contains("is-open")).toBe(true);
		expect(queryByTestId("tool-activity-body")).not.toBeNull();

		// …and closing it again removes both.
		await rerender({ item: item(searchSegment), open: false, onToggle });
		expect(getByTestId("tool-activity-row").classList.contains("is-open")).toBe(
			false,
		);
	});

	it("never renders a row with nothing to reveal as clickable", () => {
		const { getByTestId } = render(ToolActivityRow, {
			item: item({ name: "some_new_tool", input: {} }),
		});
		const row = getByTestId("tool-activity-row");
		expect(row.tagName.toLowerCase()).toBe("div");
		expect(row.querySelector(".act-chevron")).toBeNull();
	});

	it("renders a search body as a source list with the cited tick and the hover excerpt", () => {
		const { getByTestId } = render(ToolActivityRow, {
			item: item(searchSegment),
			open: true,
		});

		const body = getByTestId("tool-activity-body");
		expect(body.querySelector(".act-eyebrow")?.textContent).toContain(
			"Sources",
		);
		expect(body.querySelector(".act-eyebrow")?.textContent).toContain(
			"1 cited",
		);
		const source = body.querySelector<HTMLAnchorElement>("a.act-src");
		expect(source?.getAttribute("href")).toBe("https://met.ie/cork");
		expect(source?.querySelector(".act-src-title")?.textContent).toBe(
			"Cork city forecast",
		);
		expect(source?.querySelector(".act-src-cited")).not.toBeNull();
		expect(
			source?.querySelector(".act-src-popover-reason")?.textContent,
		).toContain("Saturday: wet and windy");
	});

	// The popover used to be `display: none` until :hover, which cannot
	// animate — it popped in and out. It is now always laid out and animates
	// its opacity/transform, with `visibility` (not `display`) carrying the
	// hidden semantics so it stays out of hit-testing and the a11y tree.
	// jsdom applies no component CSS, so the stylesheet itself is the subject
	// here — the same approach reduced-motion-transitions.regression.test.ts
	// takes for style-only guarantees.
	it("keeps the source popover mounted and hidden by visibility, not display", () => {
		const { getByTestId } = render(ToolActivityRow, {
			item: item(searchSegment),
			open: true,
		});

		const popover =
			getByTestId("tool-activity-body").querySelector(".act-src-popover");
		// Rendered up front (nothing waits for a hover to create it) and
		// hidden from assistive tech, since the row's `title` already says it.
		expect(popover).not.toBeNull();
		expect(popover?.getAttribute("aria-hidden")).toBe("true");

		const source = readFileSync(
			`${process.cwd()}/src/lib/components/chat/ToolActivityRow.svelte`,
			"utf-8",
		);
		const hiddenRule =
			source.match(/\n\t\.act-src-popover \{([\s\S]*?)\n\t\}/)?.[1] ?? "";
		expect(hiddenRule).not.toBe("");
		expect(hiddenRule).not.toMatch(/display:\s*none/);
		expect(hiddenRule).toMatch(/opacity:\s*0/);
		expect(hiddenRule).toMatch(/visibility:\s*hidden/);
		expect(hiddenRule).toMatch(/transform:\s*translateY\(-4px\)/);
		expect(hiddenRule).toMatch(/pointer-events:\s*none/);
		// Both directions animate: the transition lives on the hidden state
		// (fade-out) as well as the shown one (fade-in), at the app's standard
		// duration and easing, with `visibility` stepping only at the end.
		expect(hiddenRule).toMatch(
			/transition:\s*opacity var\(--duration-standard\) var\(--ease-out\)/,
		);
		expect(hiddenRule).toMatch(
			/visibility 0s linear var\(--duration-standard\)/,
		);

		const shownRule =
			source.match(
				/\.act-src:hover \.act-src-popover,\n\t\.act-src:focus-visible \.act-src-popover \{([\s\S]*?)\n\t\}/,
			)?.[1] ?? "";
		expect(shownRule).not.toBe("");
		expect(shownRule).toMatch(/opacity:\s*1/);
		expect(shownRule).toMatch(/visibility:\s*visible/);
		expect(shownRule).toMatch(/transform:\s*translateY\(0\)/);
		expect(shownRule).toMatch(
			/transition:\s*opacity var\(--duration-standard\) var\(--ease-out\)/,
		);

		// Reduced motion keeps the fade but drops the slide.
		const reducedMotionBlock =
			source.match(
				/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\t\}\n<\/style>/,
			)?.[1] ?? "";
		expect(reducedMotionBlock).toMatch(
			/\.act-src-popover,[\s\S]*?transform:\s*none/,
		);
	});

	it("renders a Python body as PROGRAM and OUTPUT code blocks", () => {
		const { getByTestId } = render(ToolActivityRow, {
			item: item({
				name: "run_python",
				input: { code: "# check\nprint(1)" },
				outputSummary: "1",
			}),
			open: true,
		});

		const body = getByTestId("tool-activity-body");
		const eyebrows = [...body.querySelectorAll(".act-eyebrow")].map(
			(node) => node.textContent,
		);
		expect(eyebrows).toEqual(["Program", "Output"]);
		const code = [...body.querySelectorAll("pre.act-code")].map(
			(node) => node.textContent,
		);
		expect(code).toEqual(["# check\nprint(1)", "1"]);
	});

	it("renders a connector group body as one row per action", () => {
		const tools = [
			toolCall({ name: "calendar", input: { action: "list_events" } }),
			toolCall({
				name: "calendar",
				input: { action: "create_event" },
				status: "failed",
			}),
		];
		const { getAllByTestId } = render(ToolActivityRow, {
			item: buildConnectorActivityItem(tools, "group-1", get(t)),
			open: true,
		});

		const actions = getAllByTestId("tool-activity-action");
		expect(actions).toHaveLength(2);
		expect(actions[0].textContent).toContain("list events");
		expect(actions[1].querySelector(".act-status.failed")).not.toBeNull();
	});

	it("renders a memory body as bullets", () => {
		const { getByTestId } = render(ToolActivityRow, {
			item: item({
				name: "memory_context",
				input: {},
				candidates: [
					{ id: "m1", title: "Prefers Celsius", sourceType: "memory" },
				] as ToolCallSegment["candidates"],
			}),
			open: true,
		});
		expect(
			getByTestId("tool-activity-body").querySelectorAll("ul.act-bullets li"),
		).toHaveLength(1);
	});

	it("renders a generic tool body as its arguments and result", () => {
		const { getByTestId } = render(ToolActivityRow, {
			item: item({
				name: "some_new_tool",
				input: { thing: "value" },
				outputSummary: "it worked",
			}),
			open: true,
		});

		const body = getByTestId("tool-activity-body");
		expect(body.querySelector(".act-kv-key")?.textContent).toBe("thing");
		expect(body.querySelector(".act-kv-value")?.textContent).toBe("value");
		expect(body.textContent).toContain("it worked");
	});

	it("lists the transit itinerary legs above the map", () => {
		const { getByTestId, queryByTestId } = render(ToolActivityRow, {
			item: item({
				name: "map_route",
				input: { action: "transit" },
				map: {
					bounds: { minLat: 49.3, minLng: 8.6, maxLat: 49.5, maxLng: 8.8 },
					durationS: 1620,
					mode: "transit",
					transfers: 1,
					originLabel: "Dossenheim",
					destinationLabel: "Heidelberg",
					transitLegs: [
						{
							type: "walk",
							depart: "08:25",
							arrive: "08:28",
							minutes: 3,
							distanceM: 220,
						},
						{
							type: "pt",
							line: "39A",
							headsign: "Bismarckplatz",
							from: "Dossenheim, Süd",
							to: "Heidelberg, Alois-Link-Platz",
							depart: "08:31",
							arrive: "08:50",
							stops: 7,
							minutes: 19,
						},
					],
					attribution: "© OpenStreetMap contributors",
				},
			} as Partial<ToolCallSegment>),
			open: true,
		});

		// The body is the route itinerary now: a timeline row per leg plus the
		// arrival, with the line, headsign and stop count on the ride.
		const timeline = getByTestId("itinerary-timeline");
		expect(
			timeline.querySelectorAll("[data-testid='itinerary-leg']"),
		).toHaveLength(3);
		const text = timeline.textContent ?? "";
		expect(text).toContain("08:31");
		expect(text).toContain("39A");
		expect(text).toContain("Dossenheim, Süd");
		expect(text).toContain("Heidelberg, Alois-Link-Platz");
		expect(text).toContain("Bismarckplatz");
		expect(text).toContain("7 stops");
		// The walk leg is named rather than left blank.
		expect(text).toContain("Walk");
		expect(queryByTestId("itinerary-departure")).toBeNull();
	});

	it("lists the next departures for a timetable call", () => {
		const { getAllByTestId, queryByTestId } = render(ToolActivityRow, {
			item: item({
				name: "map_route",
				input: { action: "timetable" },
				map: {
					bounds: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
					durationS: 1620,
					mode: "transit",
					transfers: 1,
					originLabel: "A",
					destinationLabel: "B",
					departures: [
						{
							depart: "08:25",
							arrive: "08:52",
							minutes: 27,
							transfers: 1,
							line: "39A",
						},
						{ depart: "08:45", arrive: "09:12", minutes: 27, transfers: 0 },
					],
					attribution: "© OpenStreetMap contributors",
				},
			} as Partial<ToolCallSegment>),
			open: true,
		});

		const rows = getAllByTestId("itinerary-departure");
		expect(rows).toHaveLength(2);
		const text = rows.map((row) => row.textContent ?? "").join(" ");
		expect(text).toContain("08:25");
		expect(text).toContain("08:52");
		expect(text).toContain("1 change");
		expect(text).toContain("0 changes");
		expect(queryByTestId("itinerary-timeline")).toBeNull();
	});

	it("localizes the row grammar with the UI language", () => {
		uiLanguage.set("hu");
		try {
			const { getByTestId } = render(ToolActivityRow, {
				item: item(searchSegment),
			});
			expect(
				getByTestId("tool-activity-row").querySelector(".act-verb")
					?.textContent,
			).toBe("Keresés");
		} finally {
			uiLanguage.set("en");
		}
	});
});
