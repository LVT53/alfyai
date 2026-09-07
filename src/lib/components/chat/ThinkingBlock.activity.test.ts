// Unified tool activity rows — coverage for the states this redesign adds on
// top of ThinkingBlock's existing behaviour (which ThinkingBlock.test.ts
// covers): the collapsed summary strip, pinned deliverables surviving the
// collapse, and a producing file row that is open on its own.
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { beforeEach, describe, expect, it } from "vitest";
import type { FileProductionJob } from "$lib/server/services/file-production/types";
import type { ThinkingSegment } from "$lib/server/services/messages-types";
import { uiLanguage } from "$lib/stores/settings";
import ThinkingBlock from "./ThinkingBlock.svelte";

const routeSegment: ThinkingSegment = {
	type: "tool_call",
	callId: "call-route",
	name: "map_route",
	input: { action: "route" },
	status: "done",
	map: {
		bounds: { minLat: 51.6, minLng: -8.6, maxLat: 51.9, maxLng: -8.3 },
		distanceM: 27_000,
		durationS: 2040,
		originLabel: "Cork",
		destinationLabel: "Kinsale",
		attribution: "© OpenStreetMap contributors",
	},
};

const searchSegment: ThinkingSegment = {
	type: "tool_call",
	callId: "call-search",
	name: "research_web",
	input: { query: "cork weather" },
	status: "done",
	candidates: [
		{
			id: "c1",
			title: "Cork city forecast",
			url: "https://met.ie/cork",
			sourceType: "web",
			status: "selected",
		},
	],
};

function makeJob(
	overrides: Partial<FileProductionJob> = {},
): FileProductionJob {
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
				mimeType: "application/vnd.ms-excel",
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

describe("ThinkingBlock tool activity", () => {
	beforeEach(() => {
		uiLanguage.set("en");
	});

	it("shows the live list while the turn is running, with no summary strip", () => {
		render(ThinkingBlock, {
			props: {
				content: "Checking the forecast.",
				thinkingIsDone: false,
				segments: [searchSegment],
			},
		});

		expect(screen.getByTestId("tool-activity-stack")).toBeInTheDocument();
		expect(screen.queryByTestId("tool-activity-summary")).toBeNull();
		expect(
			within(screen.getByTestId("tool-activity-stack")).getByTestId(
				"tool-activity-row",
			).textContent,
		).toContain("Searched");
	});

	it("folds the finished list into one summary strip once the block is collapsed", () => {
		render(ThinkingBlock, {
			props: {
				content: "Checking the forecast.",
				thinkingIsDone: true,
				thinkingDurationSeconds: 14,
				segments: [searchSegment],
			},
		});

		expect(screen.queryByTestId("tool-activity-stack")).toBeNull();
		const strip = screen.getByTestId("tool-activity-summary");
		expect(strip.textContent).toContain("Searched 1 source");
		expect(strip.querySelector(".summary-item")).not.toBeNull();
	});

	it("expands the whole thinking block when the summary strip is clicked", async () => {
		render(ThinkingBlock, {
			props: {
				content: "Checking the forecast.",
				thinkingIsDone: true,
				thinkingDurationSeconds: 14,
				segments: [searchSegment],
			},
		});

		await fireEvent.click(screen.getByTestId("tool-activity-summary"));

		expect(screen.queryByTestId("tool-activity-summary")).toBeNull();
		expect(
			screen
				.getByRole("button", { name: /Thought for/i })
				.getAttribute("aria-expanded"),
		).toBe("true");
		expect(screen.getByTestId("tool-activity-row")).toBeInTheDocument();
	});

	it("keeps a route deliverable as a pinned row with its body open when collapsed", () => {
		render(ThinkingBlock, {
			props: {
				content: "Working out the distance.",
				thinkingIsDone: true,
				thinkingDurationSeconds: 14,
				segments: [searchSegment, routeSegment],
			},
		});

		// The route never folds into the strip…
		expect(
			screen.getByTestId("tool-activity-summary").textContent,
		).not.toContain("Route");
		// …it keeps a row of its own, open.
		const pinned = screen.getByTestId("tool-activity-pinned");
		const row = within(pinned).getByTestId("tool-activity-row");
		expect(row.textContent).toContain("Cork → Kinsale");
		expect(row.textContent).toContain("27.0 km · 34 min");
		expect(row.classList.contains("is-open")).toBe(true);
		expect(
			within(pinned).getByTestId("tool-activity-body"),
		).toBeInTheDocument();
	});

	it("renders a produced file as a pinned row, outside the thinking rail entirely", () => {
		render(ThinkingBlock, {
			props: {
				content: "Building the workbook.",
				thinkingIsDone: true,
				thinkingDurationSeconds: 14,
				segments: [searchSegment],
				fileProductionJobs: [makeJob()],
			},
		});

		const files = screen.getByTestId("tool-activity-files");
		const row = within(files).getByTestId("tool-activity-row");
		expect(row.textContent).toContain("Created");
		expect(row.textContent).toContain("Cork weekend packing list.xlsx");
		expect(row.textContent).toContain("12 KB");
	});

	it("keeps a producing file row open on its own, with no chevron to close it", () => {
		render(ThinkingBlock, {
			props: {
				content: "Building the workbook.",
				thinkingIsDone: false,
				segments: [searchSegment],
				fileProductionJobs: [makeJob({ status: "running", files: [] })],
			},
		});

		const files = screen.getByTestId("tool-activity-files");
		const row = within(files).getByTestId("tool-activity-row");
		expect(row.dataset.status).toBe("running");
		expect(row.textContent).toContain("Creating");
		// Row + body share one background: the row is `is-open` and is not a
		// button, so nothing invites the user to close a job in flight.
		expect(row.classList.contains("is-open")).toBe(true);
		expect(row.tagName.toLowerCase()).toBe("div");
		expect(row.querySelector(".act-chevron")).toBeNull();
		expect(within(files).getByTestId("tool-activity-body")).toBeInTheDocument();
	});

	it("renders a file job with no reasoning behind it as a bare pinned row, with no thinking header", () => {
		render(ThinkingBlock, {
			props: {
				content: "",
				thinkingIsDone: true,
				segments: [],
				fileProductionJobs: [makeJob()],
			},
		});

		expect(screen.getByTestId("tool-activity-files")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /Thought/i })).toBeNull();
	});

	it("opens and closes a row's body from the live list", async () => {
		render(ThinkingBlock, {
			props: {
				content: "Checking the forecast.",
				thinkingIsDone: false,
				segments: [searchSegment],
			},
		});

		const row = screen.getByTestId("tool-activity-row");
		expect(screen.queryByTestId("tool-activity-body")).toBeNull();

		await fireEvent.click(row);
		expect(screen.getByTestId("tool-activity-body")).toBeInTheDocument();
		expect(
			screen.getByTestId("tool-activity-row").classList.contains("is-open"),
		).toBe(true);

		await fireEvent.click(screen.getByTestId("tool-activity-row"));
		expect(
			screen.getByTestId("tool-activity-row").classList.contains("is-open"),
		).toBe(false);
	});
});
