import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import type { ThinkingSegment } from "$lib/types";
import ThinkingBlock from "./ThinkingBlock.svelte";

describe("ThinkingBlock", () => {
	it("does not render a completed Thought disclosure for hidden tool-only activity", () => {
		const segments: ThinkingSegment[] = [
			{
				type: "tool_call",
				name: "produce_file",
				status: "done",
				input: {
					requestTitle: "Quarterly report",
					previewUrl: "https://example.com/report.pdf",
				},
			},
		];

		render(ThinkingBlock, {
			props: {
				content: "",
				thinkingIsDone: true,
				segments,
			},
		});

		expect(screen.queryByText("produce_file")).not.toBeInTheDocument();
		expect(screen.queryByText(/Fetch page:/)).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Thought/i }),
		).not.toBeInTheDocument();
	});

	it("keeps completed tool activity inside completed Thought at the original trace position", async () => {
		const segments: ThinkingSegment[] = [
			{ type: "text", content: "I checked the relevant source." },
			{
				type: "tool_call",
				name: "fetch_url",
				status: "done",
				input: {
					url: "https://example.com/article",
				},
			},
		];

		render(ThinkingBlock, {
			props: {
				content: "",
				thinkingIsDone: true,
				segments,
			},
		});

		expect(screen.getByRole("button", { name: /Thought/ })).toBeInTheDocument();

		expect(
			screen.queryByText(/Thinking trace saved|Thought available/i),
		).not.toBeInTheDocument();

		await fireEvent.click(screen.getByRole("button", { name: /Thought/ }));

		expect(
			screen.getByText("I checked the relevant source."),
		).toBeInTheDocument();
		const links = screen.getAllByRole("link", { name: "example.com" });
		expect(links.length).toBeGreaterThan(0);
		expect(links[0]).toHaveAttribute("href", "https://example.com/article");
	});

	it("separates interim thought snippets for display without changing the raw trace", async () => {
		const rawTrace = "gonna search the Web.I am digging deeper.";

		render(ThinkingBlock, {
			props: {
				content: rawTrace,
				thinkingIsDone: true,
			},
		});

		await fireEvent.click(screen.getByRole("button", { name: /Thought/ }));

		const thoughtText = screen.getByText(
			/gonna search the Web\.\s+I am digging deeper\./,
		);
		expect(thoughtText.textContent).toContain(
			"gonna search the Web.\n\nI am digging deeper.",
		);
		expect(thoughtText.textContent).not.toContain(rawTrace);
		expect(rawTrace).toBe("gonna search the Web.I am digging deeper.");
	});

	it("separates active interim snippets when fresh text starts after punctuation", async () => {
		const rawTrace = "gonna search the Web.I am digging deeper.";

		const { rerender } = render(ThinkingBlock, {
			props: {
				content: "gonna search the Web.",
				thinkingIsDone: false,
			},
		});

		await fireEvent.click(screen.getByRole("button", { name: /Thinking/ }));
		await rerender({
			content: rawTrace,
			thinkingIsDone: false,
		});

		const freshText = screen.getByText("I am digging deeper.");
		const thoughtText = freshText.closest("pre");
		expect(thoughtText?.textContent).toContain(
			"gonna search the Web.\n\nI am digging deeper.",
		);
		expect(thoughtText?.textContent).not.toContain(rawTrace);
		expect(rawTrace).toBe("gonna search the Web.I am digging deeper.");
	});

	it("groups active comma-separated URL fetch inputs behind one fetched-sites disclosure", async () => {
		const segments: ThinkingSegment[] = [
			{
				type: "tool_call",
				name: "fetch_url",
				status: "running",
				input: {
					url: "https://a.example/x, https://b.example/y",
				},
			},
		];

		render(ThinkingBlock, {
			props: {
				content: "",
				thinkingIsDone: false,
				segments,
			},
		});

		expect(
			screen.getByRole("button", { name: /Thinking/ }),
		).toBeInTheDocument();
		expect(screen.getByText("Fetched: 2 sites")).toBeInTheDocument();

		await fireEvent.click(screen.getByText("Fetched: 2 sites"));
		const links = screen.getAllByRole("link", { name: /(?:a|b)\.example/ });
		expect(links).toHaveLength(2);
		expect(links[0]).toHaveAttribute("href", "https://a.example/x");
		expect(links[1]).toHaveAttribute("href", "https://b.example/y");
		expect(document.querySelectorAll(".fetched-favicon")).toHaveLength(2);
	});

	it("summarizes web search tool calls without expanding every source diagnostic", async () => {
		const segments: ThinkingSegment[] = [
			{
				type: "tool_call",
				name: "research_web",
				status: "running",
				input: {
					query: "latest pricing",
				},
				sourceType: "web",
				candidates: [
					{
						id: "source-1",
						title: "Widget Pro Store Page",
						url: "https://shop.example.com/products/widget-pro",
						sourceType: "web",
						material: true,
					},
				],
			},
		];

		render(ThinkingBlock, {
			props: {
				content: "",
				thinkingIsDone: false,
				segments,
			},
		});

		expect(
			screen.getByRole("button", { name: /Thinking/ }),
		).toBeInTheDocument();
		await fireEvent.click(screen.getByRole("button", { name: /Thinking/ }));
		expect(screen.getAllByText("Fetched: 1 site")).toHaveLength(2);
		const [firstFetchedSummary] = screen.getAllByText("Fetched: 1 site");
		if (!firstFetchedSummary) throw new Error("Missing fetched source summary");
		await fireEvent.click(firstFetchedSummary);
		expect(
			screen.getAllByRole("link", { name: "Widget Pro Store Page" }).length,
		).toBeGreaterThan(0);
		expect(
			document.querySelectorAll(".fetched-favicon").length,
		).toBeGreaterThan(0);
		expect(
			screen.queryByText('Searching: "latest pricing"'),
		).not.toBeInTheDocument();
	});

	it("uses different icons per deliberation pass", async () => {
		const segments: ThinkingSegment[] = [
			{
				type: "status",
				id: "deliberation-pass-1",
				status: "done",
				label: "Reviewing context and sources",
				passKind: "context_source_gap_review",
			},
			{
				type: "status",
				id: "deliberation-pass-2",
				status: "done",
				label: "Deepening source synthesis",
				passKind: "missed_user_need_check",
			},
			{
				type: "status",
				id: "deliberation-pass-3",
				status: "done",
				label: "Finalizing robust answer",
				passKind: "contradiction_risk_check",
			},
		];

		const { container } = render(ThinkingBlock, {
			props: {
				content: "",
				thinkingIsDone: true,
				segments,
			},
		});

		await fireEvent.click(screen.getByRole("button", { name: /Thought/ }));

		const statusRows = container.querySelectorAll(".status-step");
		expect(statusRows).toHaveLength(3);
		expect(
			statusRows[0]?.querySelector('[data-deliberation-icon="search"]'),
		).not.toBeNull();
		expect(
			statusRows[1]?.querySelector(
				'[data-deliberation-icon="clipboard-check"]',
			),
		).not.toBeNull();
		expect(
			statusRows[2]?.querySelector('[data-deliberation-icon="shield-alert"]'),
		).not.toBeNull();
	});

	it("renders deliberation status rows with the deliberation icon instead of a check icon", async () => {
		const segments: ThinkingSegment[] = [
			{
				type: "status",
				id: "deliberation-pass-1",
				status: "done",
				label: "Reviewed context and sources",
			},
			{
				type: "text",
				content: "Checked evidence and draft plan.",
			},
		];

		render(ThinkingBlock, {
			props: {
				content: "",
				thinkingIsDone: true,
				segments,
			},
		});

		expect(screen.getByRole("button", { name: /Thought/ })).toBeInTheDocument();

		await fireEvent.click(screen.getByRole("button", { name: /Thought/ }));
		await waitFor(() =>
			expect(
				screen.getByText("Reviewed context and sources"),
			).toBeInTheDocument(),
		);

		const statusRow = screen
			.getByText("Reviewed context and sources")
			.closest(".status-step");
		expect(statusRow).not.toBeNull();
		expect(statusRow?.querySelector(".check-icon")).toBeNull();
		expect(
			statusRow?.querySelector(".deliberation-status-icon"),
		).not.toBeNull();
	});

	it("shows only the latest deliberation status step while streaming", async () => {
		const { rerender } = render(ThinkingBlock, {
			props: {
				content: "",
				thinkingIsDone: false,
				streaming: true,
				segments: [
					{
						type: "status",
						id: "deliberation-pass-1",
						status: "done",
						label: "Reviewed context and sources",
					},
					{
						type: "status",
						id: "deliberation-pass-2",
						status: "running",
						label: "Checking answer plan",
					},
				],
			},
		});

		await fireEvent.click(screen.getByRole("button", { name: /Thinking/ }));

		expect(screen.getByText("Checking answer plan")).toBeInTheDocument();
		expect(
			screen.queryByText("Reviewed context and sources"),
		).not.toBeInTheDocument();

		await rerender({
			content: "",
			thinkingIsDone: true,
			streaming: false,
			segments: [
				{
					type: "status",
					id: "deliberation-pass-1",
					status: "done",
					label: "Reviewed context and sources",
				},
				{
					type: "status",
					id: "deliberation-pass-2",
					status: "done",
					label: "Checking answer plan",
				},
			],
		});
		expect(
			screen.getByText("Reviewed context and sources"),
		).toBeInTheDocument();
		expect(screen.getByText("Checking answer plan")).toBeInTheDocument();
	});

	it("groups a burst of connector tool calls into one compact summary row per capability", async () => {
		const calendarActions = [
			"list_events",
			"create_event",
			"check_availability",
			"update_event",
			"delete_event",
			"list_calendars",
		];
		const segments: ThinkingSegment[] = [
			...calendarActions.map(
				(action, i) =>
					({
						type: "tool_call",
						name: "calendar",
						status: i === calendarActions.length - 1 ? "running" : "done",
						input: { action },
					}) as const,
			),
			{
				type: "tool_call",
				name: "research_web",
				status: "done",
				input: { query: "weather forecast" },
			},
		];

		const { rerender, container } = render(ThinkingBlock, {
			props: {
				content: "",
				thinkingIsDone: false,
				segments,
			},
		});

		// Stack view: one grouped calendar summary row (count 6), not six rows.
		const groupSummary = screen.getByText("Calendar · 6 actions");
		expect(groupSummary).toBeInTheDocument();
		expect(screen.queryByText(/Calendar: list events/)).not.toBeInTheDocument();
		expect(
			screen.getByText('Web search: "weather forecast"'),
		).toBeInTheDocument();

		// Running affordance: one call in the group is still running.
		const groupRow = groupSummary.closest(".tool-call-row");
		expect(groupRow).not.toBeNull();
		expect(groupRow?.classList.contains("is-running")).toBe(true);
		expect(groupRow?.querySelector(".tool-dot")).not.toBeNull();
		expect(groupRow?.querySelector(".check-icon-header")).toBeNull();

		// Expand the group to reveal the individual actions.
		await fireEvent.click(groupSummary);
		for (const label of [
			"list events",
			"create event",
			"check availability",
			"update event",
			"delete event",
			"list calendars",
		]) {
			expect(screen.getByText(label)).toBeInTheDocument();
		}

		// Also grouped in the expanded interleaved thinking view.
		await fireEvent.click(screen.getByRole("button", { name: /Thinking/ }));
		expect(screen.getAllByText("Calendar · 6 actions")).toHaveLength(2);

		// Once every call in the group finishes, the group shows the done check.
		const allDoneSegments: ThinkingSegment[] = [
			...calendarActions.map(
				(action) =>
					({
						type: "tool_call",
						name: "calendar",
						status: "done",
						input: { action },
					}) as const,
			),
			{
				type: "tool_call",
				name: "research_web",
				status: "done",
				input: { query: "weather forecast" },
			},
		];
		await rerender({
			content: "",
			thinkingIsDone: false,
			segments: allDoneSegments,
		});
		const stackSummary = container.querySelector(
			".tool-call-stack summary.tool-label-text",
		);
		expect(stackSummary?.textContent).toBe("Calendar · 6 actions");
		const doneGroupRow = stackSummary?.closest(".tool-call-row");
		expect(doneGroupRow?.classList.contains("is-running")).toBe(false);
		expect(doneGroupRow?.querySelector(".check-icon-header")).not.toBeNull();
	});

	it("breaks the stack-view connector group when a non-connector call interrupts the run", async () => {
		const segments: ThinkingSegment[] = [
			{
				type: "tool_call",
				name: "calendar",
				status: "done",
				input: { action: "list_events" },
			},
			{
				type: "tool_call",
				name: "research_web",
				status: "done",
				input: { query: "weather forecast" },
			},
			{
				type: "tool_call",
				name: "calendar",
				status: "running",
				input: { action: "create_event" },
			},
		];

		const { container } = render(ThinkingBlock, {
			props: {
				content: "",
				thinkingIsDone: false,
				segments,
			},
		});

		// Three separate stack rows in chronological order: calendar group,
		// then the web search, then a SEPARATE calendar group — not one merged
		// calendar group followed by the web row.
		const stackRows = container.querySelectorAll(
			".tool-call-stack > .tool-call-row",
		);
		expect(stackRows).toHaveLength(3);
		expect(stackRows[0]?.textContent).toContain("Calendar");
		expect(stackRows[0]?.textContent).toContain("1 action");
		expect(stackRows[1]?.textContent).toContain(
			'Web search: "weather forecast"',
		);
		expect(stackRows[2]?.textContent).toContain("Calendar");
		expect(stackRows[2]?.textContent).toContain("1 action");

		// The second calendar group is the one still running (must not have
		// merged into the earlier, already-done calendar group).
		expect(stackRows[2]?.classList.contains("is-running")).toBe(true);
		expect(stackRows[0]?.classList.contains("is-running")).toBe(false);
	});

	it("shows fetched web source titles from research tool candidates", async () => {
		const segments: ThinkingSegment[] = [
			{
				type: "tool_call",
				name: "research_web",
				status: "done",
				input: {
					query: "latest pricing",
				},
				sourceType: "web",
				candidates: [
					{
						id: "source-1",
						title: "Widget Pro Store Page",
						url: "https://shop.example.com/products/widget-pro",
						sourceType: "web",
						material: true,
					},
				],
			},
		];

		render(ThinkingBlock, {
			props: {
				content: "",
				thinkingIsDone: true,
				segments,
			},
		});

		await fireEvent.click(screen.getByRole("button", { name: /Thought/ }));

		expect(screen.getAllByText("Fetched: 1 site").length).toBeGreaterThan(0);
		const [firstFetchedSummary] = screen.getAllByText("Fetched: 1 site");
		if (!firstFetchedSummary) throw new Error("Missing fetched source summary");
		await fireEvent.click(firstFetchedSummary);
		const links = screen.getAllByRole("link", {
			name: "Widget Pro Store Page",
		});
		expect(links.length).toBeGreaterThan(0);
		const [link] = links;
		if (!link) throw new Error("Missing fetched source link");
		expect(link).toHaveAttribute(
			"href",
			"https://shop.example.com/products/widget-pro",
		);
		expect(
			document.querySelectorAll(".fetched-favicon").length,
		).toBeGreaterThan(0);
		expect(
			screen.queryByText('Searching: "latest pricing"'),
		).not.toBeInTheDocument();
	});

	// Task 11b — the agenda peek + photo strip. Both render from the SAME
	// candidates channel every other tool_call segment already streams
	// (segment.candidates), never modelPayload — this is a display-only
	// widget on the user's own screen.
	describe("agenda peek + photo strip (Task 11b)", () => {
		it("renders an agenda peek with time, title, and location for calendar candidates", () => {
			const start1 = "2026-07-10T09:00:00.000Z";
			const start2 = "2026-07-10T13:30:00.000Z";
			const segments: ThinkingSegment[] = [
				{
					type: "tool_call",
					name: "calendar",
					status: "done",
					input: { action: "list_events" },
					candidates: [
						{
							id: "calendar:evt-1",
							title: "Team standup",
							url: "https://calendar.example/evt-1",
							sourceType: "tool",
							metadata: {
								start: start1,
								end: "2026-07-10T09:30:00.000Z",
								location: "Room 204",
							},
						},
						{
							id: "calendar:evt-2",
							title: "Dentist",
							url: "https://calendar.example/evt-2",
							sourceType: "tool",
							metadata: { start: start2, end: "2026-07-10T14:00:00.000Z" },
						},
					],
				},
			];

			render(ThinkingBlock, {
				props: { content: "", thinkingIsDone: false, segments },
			});

			const expectedTime1 = new Intl.DateTimeFormat(undefined, {
				hour: "2-digit",
				minute: "2-digit",
			}).format(new Date(start1));
			const expectedTime2 = new Intl.DateTimeFormat(undefined, {
				hour: "2-digit",
				minute: "2-digit",
			}).format(new Date(start2));

			expect(screen.getByText("Upcoming")).toBeInTheDocument();
			const rows = document.querySelectorAll(".agenda-row");
			expect(rows).toHaveLength(2);
			expect(screen.getByText("Team standup")).toBeInTheDocument();
			expect(screen.getByText("Dentist")).toBeInTheDocument();
			expect(screen.getByText("Room 204")).toBeInTheDocument();
			expect(rows[0]?.textContent).toContain(expectedTime1);
			expect(rows[1]?.textContent).toContain(expectedTime2);
		});

		it("caps the agenda peek to a handful of rows even with more candidates", () => {
			const segments: ThinkingSegment[] = [
				{
					type: "tool_call",
					name: "calendar",
					status: "done",
					input: { action: "list_events" },
					candidates: Array.from({ length: 8 }, (_, i) => ({
						id: `calendar:evt-${i}`,
						title: `Event ${i}`,
						url: `https://calendar.example/evt-${i}`,
						sourceType: "tool" as const,
						metadata: { start: `2026-07-1${i}T09:00:00.000Z` },
					})),
				},
			];

			render(ThinkingBlock, {
				props: { content: "", thinkingIsDone: false, segments },
			});

			const rows = document.querySelectorAll(".agenda-row");
			expect(rows.length).toBeGreaterThan(0);
			expect(rows.length).toBeLessThanOrEqual(5);
		});

		it("renders a photo strip whose thumbnails route through the 11a Immich proxy", () => {
			const segments: ThinkingSegment[] = [
				{
					type: "tool_call",
					name: "photos",
					status: "done",
					input: { action: "search", query: "beach" },
					candidates: [
						{
							id: "photos:asset-1",
							title: "beach.jpg",
							url: "",
							sourceType: "tool",
							metadata: { thumbnailPath: "/api/assets/asset-1/thumbnail" },
						},
						{
							id: "photos:asset-2",
							title: "sunset.jpg",
							url: "",
							sourceType: "tool",
							metadata: { thumbnailPath: "/api/assets/asset-2/thumbnail" },
						},
					],
				},
			];

			render(ThinkingBlock, {
				props: { content: "", thinkingIsDone: false, segments },
			});

			expect(screen.getByText("Photos")).toBeInTheDocument();
			const thumbs =
				document.querySelectorAll<HTMLImageElement>(".photo-strip-thumb");
			expect(thumbs).toHaveLength(2);
			expect(thumbs[0]?.getAttribute("src")).toBe(
				"/api/connections/immich/thumbnail/asset-1",
			);
			expect(thumbs[1]?.getAttribute("src")).toBe(
				"/api/connections/immich/thumbnail/asset-2",
			);
			expect(thumbs[0]?.getAttribute("loading")).toBe("lazy");
		});

		it("caps the photo strip to a handful of thumbnails even with more candidates", () => {
			const segments: ThinkingSegment[] = [
				{
					type: "tool_call",
					name: "photos",
					status: "done",
					input: { action: "search", query: "beach" },
					candidates: Array.from({ length: 12 }, (_, i) => ({
						id: `photos:asset-${i}`,
						title: `photo-${i}.jpg`,
						url: "",
						sourceType: "tool" as const,
						metadata: { thumbnailPath: `/api/assets/asset-${i}/thumbnail` },
					})),
				},
			];

			render(ThinkingBlock, {
				props: { content: "", thinkingIsDone: false, segments },
			});

			const thumbs = document.querySelectorAll(".photo-strip-thumb");
			expect(thumbs.length).toBeGreaterThan(0);
			expect(thumbs.length).toBeLessThanOrEqual(8);
		});

		it("hides a broken photo thumbnail on error without breaking the surrounding layout", async () => {
			const segments: ThinkingSegment[] = [
				{
					type: "tool_call",
					name: "photos",
					status: "done",
					input: { action: "search", query: "beach" },
					candidates: [
						{
							id: "photos:asset-1",
							title: "beach.jpg",
							url: "",
							sourceType: "tool",
							metadata: { thumbnailPath: "/api/assets/asset-1/thumbnail" },
						},
					],
				},
			];

			render(ThinkingBlock, {
				props: { content: "", thinkingIsDone: false, segments },
			});

			const img =
				document.querySelector<HTMLImageElement>(".photo-strip-thumb");
			expect(img).not.toBeNull();
			if (!img) throw new Error("Missing thumbnail img");

			await fireEvent.error(img);

			expect(img.style.display).toBe("none");
			// The rest of the thinking block is unaffected by the broken image.
			expect(document.querySelector(".thinking-block")).not.toBeNull();
		});

		it("does not render web or non-calendar/photos candidates as an agenda peek or photo strip", () => {
			const segments: ThinkingSegment[] = [
				{
					type: "tool_call",
					name: "research_web",
					status: "done",
					input: { query: "trip planning" },
					sourceType: "web",
					candidates: [
						{
							id: "source-1",
							title: "Best beaches 2026",
							url: "https://example.com/beaches",
							sourceType: "web",
							metadata: {
								start: "2026-07-10T09:00:00.000Z",
								thumbnailPath: "/api/assets/not-a-photo/thumbnail",
							},
						},
					],
				},
			];

			render(ThinkingBlock, {
				props: { content: "", thinkingIsDone: true, segments },
			});

			expect(document.querySelectorAll(".agenda-row")).toHaveLength(0);
			expect(document.querySelectorAll(".photo-strip-thumb")).toHaveLength(0);
			expect(screen.queryByText("Upcoming")).not.toBeInTheDocument();
		});
	});
});
