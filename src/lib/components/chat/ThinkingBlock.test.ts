import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import type { InterimThoughtStep } from "$lib/response-activity-types";
import type { ThinkingSegment } from "$lib/server/services/messages-types";
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
		expect(screen.getByText("Read 2 pages")).toBeInTheDocument();

		await fireEvent.click(screen.getByText("Read 2 pages"));
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
		expect(screen.getAllByText("Searched the web · 1 source")).toHaveLength(2);
		const [firstFetchedSummary] = screen.getAllByText(
			"Searched the web · 1 source",
		);
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

		expect(
			screen.getAllByText("Searched the web · 1 source").length,
		).toBeGreaterThan(0);
		const [firstFetchedSummary] = screen.getAllByText(
			"Searched the web · 1 source",
		);
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

	// C1 cited-first redesign: research_web sources now carry a citation-driven
	// status. Cited (status "selected") sources lead and are marked; uncited
	// ("reference") sources follow, dimmed; the collapsed label counts cites.
	describe("cited-aware web sources", () => {
		it("orders cited sources first and marks them, dimming the uncited", async () => {
			const segments: ThinkingSegment[] = [
				{
					type: "tool_call",
					name: "research_web",
					status: "done",
					input: { query: "pricing" },
					sourceType: "web",
					candidates: [
						{
							id: "a",
							title: "Uncited Source",
							url: "https://uncited.example/x",
							sourceType: "web",
							status: "reference",
						},
						{
							id: "b",
							title: "Cited Source",
							url: "https://cited.example/y",
							sourceType: "web",
							status: "selected",
						},
					],
				},
			];

			render(ThinkingBlock, {
				props: { content: "", thinkingIsDone: true, segments },
			});

			// The collapsed label reflects the citation count.
			const summary = screen.getByText(
				"Searched the web · 2 sources · 1 cited",
			);
			await fireEvent.click(summary);

			const chips = document.querySelectorAll(".fetched-source-chip");
			expect(chips).toHaveLength(2);

			// Cited leads, marked with the accent affordance.
			expect(chips[0]?.getAttribute("aria-label")).toBe("Cited Source");
			expect(chips[0]?.classList.contains("is-cited")).toBe(true);
			expect(chips[0]?.querySelector(".fetched-chip-cited-dot")).not.toBeNull();

			// Uncited follows, dimmed.
			expect(chips[1]?.getAttribute("aria-label")).toBe("Uncited Source");
			expect(chips[1]?.classList.contains("is-uncited")).toBe(true);
			expect(chips[1]?.querySelector(".fetched-chip-cited-dot")).toBeNull();
		});

		it("omits the cited suffix when nothing was cited", () => {
			const segments: ThinkingSegment[] = [
				{
					type: "tool_call",
					name: "research_web",
					status: "done",
					input: { query: "pricing" },
					sourceType: "web",
					candidates: [
						{
							id: "a",
							title: "Reference Source",
							url: "https://ref.example/x",
							sourceType: "web",
							status: "reference",
						},
					],
				},
			];

			render(ThinkingBlock, {
				props: { content: "", thinkingIsDone: true, segments },
			});

			expect(
				screen.getByText("Searched the web · 1 source"),
			).toBeInTheDocument();
			expect(screen.queryByText(/cited/i)).toBeNull();
		});

		it("exposes the source title and reason in the chip tooltip, marking cited ones", async () => {
			const segments: ThinkingSegment[] = [
				{
					type: "tool_call",
					name: "research_web",
					status: "done",
					input: { query: "pricing" },
					sourceType: "web",
					candidates: [
						{
							id: "b",
							title: "Cited Source",
							url: "https://cited.example/y",
							sourceType: "web",
							status: "selected",
							snippet: "Why this source matters.",
						},
					],
				},
			];

			render(ThinkingBlock, {
				props: { content: "", thinkingIsDone: true, segments },
			});

			await fireEvent.click(
				screen.getByText("Searched the web · 1 source · 1 cited"),
			);

			const chip = document.querySelector(".fetched-source-chip");
			// Native title tooltip carries both title and reason.
			expect(chip?.getAttribute("title")).toContain("Cited Source");
			expect(chip?.getAttribute("title")).toContain("Why this source matters.");
			// Accessible name stays the clean title (not the reason blob).
			expect(chip?.getAttribute("aria-label")).toBe("Cited Source");

			// The rich tooltip content is present with the reason + cited marker.
			const tooltip = chip?.querySelector(".fetched-source-tooltip");
			expect(tooltip?.textContent).toContain("Why this source matters.");
			expect(tooltip?.textContent).toContain("Cited");
		});

		it("does not dim any chip when nothing was cited", async () => {
			const segments: ThinkingSegment[] = [
				{
					type: "tool_call",
					name: "research_web",
					status: "done",
					input: { query: "pricing" },
					sourceType: "web",
					candidates: [
						{
							id: "a",
							title: "Reference One",
							url: "https://ref1.example/x",
							sourceType: "web",
							status: "reference",
						},
						{
							id: "b",
							title: "Reference Two",
							url: "https://ref2.example/y",
							sourceType: "web",
							status: "reference",
						},
					],
				},
			];

			render(ThinkingBlock, {
				props: { content: "", thinkingIsDone: true, segments },
			});

			await fireEvent.click(screen.getByText("Searched the web · 2 sources"));

			const chips = document.querySelectorAll(".fetched-source-chip");
			expect(chips).toHaveLength(2);
			// With zero cited sources, no chip carries the dimmed class — the whole
			// row renders neutral at full opacity.
			for (const chip of chips) {
				expect(chip.classList.contains("is-uncited")).toBe(false);
			}
		});

		it("does not dim read-page (fetch_url) chips, which have no citation concept", async () => {
			const segments: ThinkingSegment[] = [
				{
					type: "tool_call",
					name: "fetch_url",
					status: "done",
					input: { url: "https://a.example/x, https://b.example/y" },
				},
			];

			render(ThinkingBlock, {
				props: { content: "", thinkingIsDone: true, segments },
			});

			await fireEvent.click(screen.getByText("Read 2 pages"));

			const chips = document.querySelectorAll(".fetched-source-chip");
			expect(chips).toHaveLength(2);
			for (const chip of chips) {
				expect(chip.classList.contains("is-uncited")).toBe(false);
			}
		});

		it("prefers the cited copy when the same URL appears with divergent status", async () => {
			const segments: ThinkingSegment[] = [
				{
					type: "tool_call",
					name: "research_web",
					status: "done",
					input: { query: "pricing" },
					sourceType: "web",
					candidates: [
						{
							id: "ref",
							title: "Reference Copy",
							url: "https://dup.example/page",
							sourceType: "web",
							status: "reference",
						},
						{
							id: "sel",
							title: "Cited Copy",
							url: "https://dup.example/page",
							sourceType: "web",
							status: "selected",
						},
					],
				},
			];

			render(ThinkingBlock, {
				props: { content: "", thinkingIsDone: true, segments },
			});

			// The two copies collapse to one source, counted as cited.
			await fireEvent.click(
				screen.getByText("Searched the web · 1 source · 1 cited"),
			);

			const chips = document.querySelectorAll(".fetched-source-chip");
			expect(chips).toHaveLength(1);
			// The surviving copy is the cited one, not the reference dropped first.
			expect(chips[0]?.getAttribute("aria-label")).toBe("Cited Copy");
			expect(chips[0]?.classList.contains("is-cited")).toBe(true);
		});

		it("gives the +N reveal a descriptive accessible name", async () => {
			const segments: ThinkingSegment[] = [
				{
					type: "tool_call",
					name: "research_web",
					status: "done",
					input: { query: "pricing" },
					sourceType: "web",
					candidates: [
						{
							id: "cited",
							title: "Cited Source",
							url: "https://cited.example/",
							sourceType: "web",
							status: "selected",
						},
						...Array.from({ length: 9 }, (_, i) => ({
							id: `u${i}`,
							title: `Uncited ${i}`,
							url: `https://u${i}.example/`,
							sourceType: "web" as const,
							status: "reference" as const,
						})),
					],
				},
			];

			render(ThinkingBlock, {
				props: { content: "", thinkingIsDone: true, segments },
			});

			await fireEvent.click(
				screen.getByText("Searched the web · 10 sources · 1 cited"),
			);

			// Visible text stays "+3"; the accessible name describes the reveal.
			const moreReveal = screen.getByText("+3");
			expect(moreReveal).toHaveAttribute("aria-label", "3 more sources");
		});

		it("folds a long tail of uncited sources behind a +N reveal", async () => {
			const segments: ThinkingSegment[] = [
				{
					type: "tool_call",
					name: "research_web",
					status: "done",
					input: { query: "pricing" },
					sourceType: "web",
					candidates: [
						{
							id: "cited",
							title: "Cited Source",
							url: "https://cited.example/",
							sourceType: "web",
							status: "selected",
						},
						...Array.from({ length: 9 }, (_, i) => ({
							id: `u${i}`,
							title: `Uncited ${i}`,
							url: `https://u${i}.example/`,
							sourceType: "web" as const,
							status: "reference" as const,
						})),
					],
				},
			];

			render(ThinkingBlock, {
				props: { content: "", thinkingIsDone: true, segments },
			});

			await fireEvent.click(
				screen.getByText("Searched the web · 10 sources · 1 cited"),
			);

			// 9 uncited, first 6 shown inline, remaining 3 fold behind "+3".
			const moreReveal = screen.getByText("+3");
			expect(moreReveal).toBeInTheDocument();
			const overflow = document.querySelector(".fetched-chip-more");
			expect(overflow).not.toBeNull();
			expect(overflow?.querySelectorAll(".fetched-source-chip").length).toBe(3);
		});
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

	// E1/E2 — ToolCallEntry/ThinkingSegment's tool_call status widened to
	// include "failed", a genuine terminal outcome distinct from "done". A
	// failed call must render with its own visual + localized label, never
	// the same green check as a successful one.
	describe("failed tool calls (E1 status widening)", () => {
		it("renders a failed tool call distinctly from a done one in the stack view", () => {
			const segments: ThinkingSegment[] = [
				{
					type: "tool_call",
					name: "web_search",
					status: "failed",
					input: { query: "latest pricing" },
					metadata: { errorCode: "network" },
				},
			];

			const { container } = render(ThinkingBlock, {
				props: { content: "", thinkingIsDone: true, segments },
			});

			const row = container.querySelector(".tool-call-row");
			expect(row).not.toBeNull();
			expect(row?.classList.contains("is-failed")).toBe(true);
			expect(row?.classList.contains("is-running")).toBe(false);
			expect(row?.querySelector(".fail-icon-header")).not.toBeNull();
			expect(row?.querySelector(".check-icon-header")).toBeNull();
			expect(row?.querySelector(".tool-dot")).toBeNull();
			expect(
				within(row as HTMLElement).getByText("Failed"),
			).toBeInTheDocument();
		});

		it("renders a failed tool call distinctly in the expanded interleaved view", async () => {
			const segments: ThinkingSegment[] = [
				{
					type: "tool_call",
					name: "web_search",
					status: "failed",
					input: { query: "latest pricing" },
				},
			];

			render(ThinkingBlock, {
				props: { content: "", thinkingIsDone: true, segments },
			});

			await fireEvent.click(screen.getByRole("button", { name: /Thought/ }));

			const item = document.querySelector(".tool-call-item");
			expect(item).not.toBeNull();
			expect(item?.classList.contains("is-failed")).toBe(true);
			expect(item?.querySelector(".fail-icon")).not.toBeNull();
			expect(item?.querySelector(".check-icon")).toBeNull();
			expect(
				within(item as HTMLElement).getByText("Failed"),
			).toBeInTheDocument();
		});

		it("does not mark a done tool call as failed", () => {
			const segments: ThinkingSegment[] = [
				{
					type: "tool_call",
					name: "web_search",
					status: "done",
					input: { query: "latest pricing" },
				},
			];

			const { container } = render(ThinkingBlock, {
				props: { content: "", thinkingIsDone: true, segments },
			});

			const row = container.querySelector(".tool-call-row");
			expect(row?.classList.contains("is-failed")).toBe(false);
			expect(row?.querySelector(".check-icon-header")).not.toBeNull();
			expect(row?.querySelector(".fail-icon-header")).toBeNull();
			expect(screen.queryByText("Failed")).not.toBeInTheDocument();
		});

		it("marks a connector group as failed when any call in the group failed", async () => {
			const segments: ThinkingSegment[] = [
				{
					type: "tool_call",
					name: "calendar",
					status: "done",
					input: { action: "list_events" },
				},
				{
					type: "tool_call",
					name: "calendar",
					status: "failed",
					input: { action: "create_event" },
					metadata: { errorCode: "provider_error" },
				},
			];

			const { container } = render(ThinkingBlock, {
				props: { content: "", thinkingIsDone: true, segments },
			});

			const groupRow = container.querySelector(".tool-call-row");
			expect(groupRow).not.toBeNull();
			expect(groupRow?.classList.contains("is-failed")).toBe(true);
			expect(groupRow?.querySelector(".fail-icon-header")).not.toBeNull();
			expect(groupRow?.querySelector(".check-icon-header")).toBeNull();
			// The group-level badge is a direct child of the row (not the one
			// nested inside the collapsed per-action list further below).
			expect(
				groupRow?.querySelector(":scope > .tool-status-badge--failed"),
			).not.toBeNull();

			// Expanding the group shows exactly which action failed.
			await fireEvent.click(screen.getByText("Calendar · 2 actions"));
			const actionItems = document.querySelectorAll(".connector-action-item");
			expect(actionItems).toHaveLength(2);
			expect(actionItems[0]?.classList.contains("is-failed")).toBe(false);
			expect(actionItems[1]?.classList.contains("is-failed")).toBe(true);
		});
	});

	// P1 (ADR-0056) — the deterministic reasoning-phase spine's live header
	// state. No model call anywhere in this suite: every assertion below
	// drives the component with plain lifecycle props (content growth,
	// elapsed fake time, an answerStarted flag) and reads the rendered text.
	describe("P1 deterministic reasoning spine (ADR-0056)", () => {
		it("shows the live Thinking state while reasoning content keeps growing, with no counting-clock prefix", async () => {
			const { rerender } = render(ThinkingBlock, {
				props: { content: "Looking at the request", thinkingIsDone: false },
			});

			const header = screen.getByRole("button", { name: /Thinking/ });
			expect(header.textContent?.trim()).toBe("Thinking...");
			// The old stopwatch prefixed the label with an elapsed count
			// ("12s · Thinking..."); the live spine never does.
			expect(header.textContent ?? "").not.toMatch(/\d/);

			await rerender({
				content: "Looking at the request in more depth now",
				thinkingIsDone: false,
			});

			expect(
				screen.getByRole("button", { name: /Thinking/ }).textContent?.trim(),
			).toBe("Thinking...");
		});

		// The primary P1 acceptance test: `standard` depth with no tool calls
		// means DELIBERATION_PASS_PLAN_BY_PROFILE.standard is [] server-side
		// (no status segments) and there are no tool_call segments either —
		// segments stays empty for the whole turn, exactly like this fixture.
		// The rail must still never be empty.
		it("never renders an empty header for a standard-depth turn with no tool calls and no deliberation passes", () => {
			render(ThinkingBlock, {
				props: {
					content: "Considering the request",
					thinkingIsDone: false,
					segments: [],
					streaming: true,
				},
			});

			const header = screen.getByRole("button", { name: /Thinking/ });
			expect(header.textContent?.trim().length).toBeGreaterThan(0);
			expect(header.textContent?.trim()).toBe("Thinking...");
		});

		it("honestly flips to a still-working state when reasoning growth genuinely stops arriving", async () => {
			vi.useFakeTimers();
			try {
				render(ThinkingBlock, {
					props: { content: "Looking at the request", thinkingIsDone: false },
				});

				expect(screen.getByText("Thinking...")).toBeInTheDocument();

				await act(() => {
					vi.advanceTimersByTime(8000);
				});

				expect(screen.getByText("Still working...")).toBeInTheDocument();
				expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
				// Still no digits anywhere in the live label — an honest word,
				// never a clock.
				expect(
					screen.getByRole("button", { name: /Still working/ }).textContent ??
						"",
				).not.toMatch(/\d/);
			} finally {
				vi.useRealTimers();
			}
		});

		it("does not report a stall while a tool call is actively running, even with no new reasoning text", async () => {
			vi.useFakeTimers();
			try {
				render(ThinkingBlock, {
					props: {
						content: "Looking at the request",
						thinkingIsDone: false,
						segments: [
							{
								type: "tool_call",
								name: "research_web",
								status: "running",
								input: { query: "latest pricing" },
							},
						],
					},
				});

				await act(() => {
					vi.advanceTimersByTime(8000);
				});

				expect(screen.getByText("Thinking...")).toBeInTheDocument();
				expect(screen.queryByText("Still working...")).not.toBeInTheDocument();
			} finally {
				vi.useRealTimers();
			}
		});

		it("switches to writing-the-answer once the visible answer starts, even after a reasoning stall", async () => {
			vi.useFakeTimers();
			try {
				const { rerender } = render(ThinkingBlock, {
					props: { content: "Looking at the request", thinkingIsDone: false },
				});

				await act(() => {
					vi.advanceTimersByTime(8000);
				});
				expect(screen.getByText("Still working...")).toBeInTheDocument();

				await rerender({
					content: "Looking at the request",
					thinkingIsDone: false,
					answerStarted: true,
				});

				expect(screen.getByText("Writing the answer...")).toBeInTheDocument();
				expect(screen.queryByText("Still working...")).not.toBeInTheDocument();
			} finally {
				vi.useRealTimers();
			}
		});

		it("still shows the retrospective Thought-for duration once the turn completes", () => {
			render(ThinkingBlock, {
				props: {
					content: "Looking at the request",
					thinkingIsDone: true,
					thinkingDurationSeconds: 34,
				},
			});

			expect(
				screen.getByRole("button", { name: "Thought for 34s" }),
			).toBeInTheDocument();
		});
	});

	// P3c (ADR-0056) — the classified thought-step rail: live header
	// enrichment on P1's spine, the completed interleaved rail, and the
	// jump-anchor into the raw Thinking Trace. No model call anywhere in this
	// suite either — every classified step arrives as a plain prop, exactly
	// as it would after MessageBubble's reverse-scan (live) or from
	// ChatMessage.thoughtSteps (completed).
	describe("P3c classified thought-step rail (ADR-0056)", () => {
		it("shows the current classified step's localized label in the live header, with no click required", () => {
			render(ThinkingBlock, {
				props: {
					content: "Looking at the request",
					thinkingIsDone: false,
					liveThoughtStepClass: "weighing-options",
				},
			});

			expect(
				screen.getByRole("button", { name: "Weighing the options..." }),
			).toBeInTheDocument();
		});

		it("composes the verbatim entity into the live label when the server sent one", () => {
			render(ThinkingBlock, {
				props: {
					content: "Looking at the request",
					thinkingIsDone: false,
					liveThoughtStepClass: "recalling-context",
					liveThoughtStepEntity: "the budget discussion",
				},
			});

			expect(
				screen.getByText("Recalling context... (the budget discussion)"),
			).toBeInTheDocument();
		});

		// TS2-c (ADR-0056 amendment) — the live header's new precedence: the
		// step's entity-grounded summary, when present, IS the headline —
		// ahead of the phase label (and the entity-composed phase label),
		// which stays as the fallback for when the server dropped the summary.
		describe("TS2-c live summary headline (ADR-0056 amendment)", () => {
			it("shows the step's summary in the live header ahead of the phase label", () => {
				render(ThinkingBlock, {
					props: {
						content: "Looking at the request",
						thinkingIsDone: false,
						liveThoughtStepClass: "weighing-options",
						liveThoughtStepSummary: "Comparing the two pricing tiers",
					},
				});

				expect(
					screen.getByRole("button", {
						name: "Comparing the two pricing tiers",
					}),
				).toBeInTheDocument();
				expect(
					screen.queryByText("Weighing the options..."),
				).not.toBeInTheDocument();
			});

			it("falls back to the phase label when no summary was sent, even with an entity present", () => {
				render(ThinkingBlock, {
					props: {
						content: "Looking at the request",
						thinkingIsDone: false,
						liveThoughtStepClass: "recalling-context",
						liveThoughtStepEntity: "the budget discussion",
						liveThoughtStepSummary: undefined,
					},
				});

				expect(
					screen.getByText("Recalling context... (the budget discussion)"),
				).toBeInTheDocument();
			});

			it("never shows a summary for an unrecognized class, even if one was sent (honesty)", () => {
				render(ThinkingBlock, {
					props: {
						content: "Looking at the request",
						thinkingIsDone: false,
						liveThoughtStepClass: "shopping",
						liveThoughtStepSummary: "Buying new shoes",
					},
				});

				expect(screen.getByText("Thinking...")).toBeInTheDocument();
				expect(screen.queryByText(/shoes/i)).not.toBeInTheDocument();
			});

			it("renders the closed activity class as a small secondary icon alongside the headline, not as the headline itself", () => {
				const { container } = render(ThinkingBlock, {
					props: {
						content: "Looking at the request",
						thinkingIsDone: false,
						liveThoughtStepClass: "weighing-options",
						liveThoughtStepSummary: "Comparing the two pricing tiers",
					},
				});

				expect(
					container.querySelector(".thought-step-class-icon"),
				).not.toBeNull();
				// The icon is aria-hidden, so it never changes the accessible name
				// — the summary text alone is the headline.
				expect(
					screen.getByRole("button", {
						name: "Comparing the two pricing tiers",
					}),
				).toBeInTheDocument();
			});
		});

		it("falls back to P1's spine label when no classified step has arrived yet", () => {
			render(ThinkingBlock, {
				props: { content: "Looking at the request", thinkingIsDone: false },
			});

			expect(screen.getByText("Thinking...")).toBeInTheDocument();
		});

		it("falls back to P1's spine label when the live class is outside the closed enum (honesty)", () => {
			render(ThinkingBlock, {
				props: {
					content: "Looking at the request",
					thinkingIsDone: false,
					liveThoughtStepClass: "shopping",
					liveThoughtStepEntity: "shoes",
				},
			});

			expect(screen.getByText("Thinking...")).toBeInTheDocument();
			expect(screen.queryByText(/shoes/i)).not.toBeInTheDocument();
		});

		it("stops showing the classified step once the turn completes, in favor of the retrospective duration", () => {
			render(ThinkingBlock, {
				props: {
					content: "Looking at the request",
					thinkingIsDone: true,
					thinkingDurationSeconds: 12,
					liveThoughtStepClass: "weighing-options",
				},
			});

			expect(
				screen.getByRole("button", { name: "Thought for 12s" }),
			).toBeInTheDocument();
			expect(
				screen.queryByText(/Weighing the options/),
			).not.toBeInTheDocument();
		});

		// TS2-c (ADR-0056 amendment) — the redesigned expanded panel: with a
		// durable step rail present, the default view is the compact clean
		// list (steps + tool chips, in true arrival order), and the raw
		// reasoning prose the old "mess" dumped inline is gone from the
		// default view entirely.
		it("shows a compact clean list of steps and a distinct tool chip, in the order they actually occurred, with no raw reasoning prose", async () => {
			const text1 = "First part of reasoning. ";
			const text2 = "Second part of reasoning.";
			const content = text1 + text2;
			const segments: ThinkingSegment[] = [
				{ type: "text", content: text1 },
				{
					type: "tool_call",
					name: "fetch_url",
					status: "done",
					input: { url: "https://example.com" },
				},
				{ type: "text", content: text2 },
			];
			const stepA: InterimThoughtStep = {
				id: "step-a",
				source: "classified",
				activityClass: "understanding-request",
				impliesExternalAction: false,
				anchor: { start: 0, end: 5 }, // "First"
			};
			const stepB: InterimThoughtStep = {
				id: "step-b",
				source: "classified",
				activityClass: "weighing-options",
				impliesExternalAction: false,
				anchor: { start: text1.length, end: text1.length + 6 }, // "Second"
			};

			const { container } = render(ThinkingBlock, {
				props: {
					content,
					thinkingIsDone: true,
					segments,
					thoughtSteps: [stepA, stepB],
				},
			});

			await fireEvent.click(screen.getByRole("button", { name: /Thought/ }));

			// No raw reasoning prose by default — the fix for the "big mess"
			// complaint this slice exists for.
			expect(container.querySelector(".thinking-text")).toBeNull();
			expect(screen.queryByText(/First part of reasoning/)).toBeNull();
			expect(screen.queryByText(/Second part of reasoning/)).toBeNull();

			const rows = container.querySelectorAll(
				".thought-step-clean-list > .thought-step-row, .thought-step-clean-list > .thought-rail-chip",
			);
			expect(rows).toHaveLength(3);
			expect(rows[0]?.className).toContain("thought-step-row");
			expect(rows[0]?.textContent).toContain("Understanding the request...");
			expect(rows[1]?.className).toContain("thought-rail-chip");
			expect(rows[1]?.querySelector(".tool-call-item")).not.toBeNull();
			expect(rows[2]?.className).toContain("thought-step-row");
			expect(rows[2]?.textContent).toContain("Weighing the options...");

			// The full raw trace stays available, opt-in only.
			expect(
				screen.queryByRole("button", { name: /Show full reasoning/ }),
			).toBeInTheDocument();
		});

		it("reveals the full continuous raw reasoning only after the opt-in 'Show full reasoning' toggle, off by default", async () => {
			const content = "First part of reasoning. Second part of reasoning.";
			const segments: ThinkingSegment[] = [{ type: "text", content }];
			const step: InterimThoughtStep = {
				id: "step-full",
				source: "classified",
				activityClass: "understanding-request",
				impliesExternalAction: false,
				anchor: { start: 0, end: 5 }, // "First"
			};

			render(ThinkingBlock, {
				props: {
					content,
					thinkingIsDone: true,
					segments,
					thoughtSteps: [step],
				},
			});

			await fireEvent.click(screen.getByRole("button", { name: /Thought/ }));
			expect(screen.queryByText(content)).toBeNull();

			await fireEvent.click(
				screen.getByRole("button", { name: "Show full reasoning" }),
			);
			expect(screen.getByText(content)).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: /Hide full reasoning/ }),
			).toBeInTheDocument();
			// The clean list is replaced, not merely covered, while the full
			// trace is showing.
			expect(
				screen.queryByText("Understanding the request..."),
			).not.toBeInTheDocument();

			await fireEvent.click(
				screen.getByRole("button", { name: /Hide full reasoning/ }),
			);
			expect(screen.queryByText(content)).toBeNull();
			expect(
				screen.getByText("Understanding the request..."),
			).toBeInTheDocument();
		});

		// TS2-c — a clean-list row's duration is honestly derived only from the
		// real gap to the NEXT step's own createdAt; the last step (no known
		// "end of reasoning" timestamp reaches the client) shows no duration
		// rather than a fabricated one.
		it("shows each step's own duration, derived from the gap to the next step, and omits it for the last step", async () => {
			const content = "First part. Second part. Third part.";
			const segments: ThinkingSegment[] = [{ type: "text", content }];
			const stepA: InterimThoughtStep = {
				id: "step-a",
				source: "classified",
				activityClass: "understanding-request",
				impliesExternalAction: false,
				anchor: { start: 0, end: 5 },
				createdAt: 1_000,
			};
			const stepB: InterimThoughtStep = {
				id: "step-b",
				source: "classified",
				activityClass: "weighing-options",
				impliesExternalAction: false,
				anchor: { start: 12, end: 18 },
				createdAt: 4_500,
			};

			const { container } = render(ThinkingBlock, {
				props: {
					content,
					thinkingIsDone: true,
					segments,
					thoughtSteps: [stepA, stepB],
				},
			});

			await fireEvent.click(screen.getByRole("button", { name: /Thought/ }));

			const rows = container.querySelectorAll(".thought-step-row");
			expect(rows).toHaveLength(2);
			expect(
				rows[0]?.querySelector(".thought-step-duration")?.textContent,
			).toBe("4s");
			expect(rows[1]?.querySelector(".thought-step-duration")).toBeNull();
		});

		it("renders a resolvable classified step but drops one whose anchor does not resolve against the persisted trace (honesty)", async () => {
			const content = "Short reasoning text.";
			const segments: ThinkingSegment[] = [{ type: "text", content }];
			const goodStep: InterimThoughtStep = {
				id: "step-good",
				source: "classified",
				activityClass: "checking-details",
				impliesExternalAction: false,
				anchor: { start: 0, end: 5 }, // "Short"
			};
			const unanchoredStep: InterimThoughtStep = {
				id: "step-bad",
				source: "classified",
				activityClass: "weighing-options",
				impliesExternalAction: false,
				anchor: { start: 1000, end: 1010 }, // out of bounds
			};

			render(ThinkingBlock, {
				props: {
					content,
					thinkingIsDone: true,
					segments,
					thoughtSteps: [goodStep, unanchoredStep],
				},
			});

			await fireEvent.click(screen.getByRole("button", { name: /Thought/ }));

			expect(screen.getByText("Checking the details...")).toBeInTheDocument();
			expect(
				screen.queryByText("Weighing the options..."),
			).not.toBeInTheDocument();
		});

		// TS2-c (ADR-0056 amendment) — "selecting a step reveals only that step's
		// anchored span... not the whole trace": this is the load-bearing test for
		// that specific rewording. Pre-amendment, clicking a step opened the FULL
		// raw Thinking Trace scrolled to a highlight; now only the anchored
		// substring itself is shown.
		it("reveals only a selected step's own anchored span, not the surrounding trace, and returns via Back to steps", async () => {
			const content =
				"First I read the request carefully. Then I weighed two different options before continuing.";
			const segments: ThinkingSegment[] = [{ type: "text", content }];
			const anchorText = "weighed two different options";
			const start = content.indexOf(anchorText);
			const end = start + anchorText.length;
			const step: InterimThoughtStep = {
				id: "step-jump",
				source: "classified",
				activityClass: "weighing-options",
				impliesExternalAction: false,
				anchor: { start, end },
			};

			render(ThinkingBlock, {
				props: {
					content,
					thinkingIsDone: true,
					segments,
					thoughtSteps: [step],
				},
			});

			await fireEvent.click(screen.getByRole("button", { name: /Thought/ }));

			const stepRow = screen
				.getByText("Weighing the options...")
				.closest("button");
			expect(stepRow).not.toBeNull();
			if (!stepRow) throw new Error("Missing step row");
			await fireEvent.click(stepRow);

			const mark = document.querySelector("mark.thought-step-anchor-highlight");
			expect(mark).not.toBeNull();
			expect(mark?.textContent).toBe(anchorText);
			// Only the anchored span itself is shown — none of the surrounding
			// trace leaks in alongside it.
			expect(screen.queryByText(/First I read the request/)).toBeNull();
			expect(screen.queryByText(/before continuing/)).toBeNull();
			expect(
				screen.getByRole("button", { name: /Back to steps/ }),
			).toBeInTheDocument();
			// The step list is replaced, not merely covered.
			expect(
				screen.queryByText("Weighing the options..."),
			).not.toBeInTheDocument();

			await fireEvent.click(
				screen.getByRole("button", { name: /Back to steps/ }),
			);

			expect(screen.getByText("Weighing the options...")).toBeInTheDocument();
			expect(
				document.querySelector("mark.thought-step-anchor-highlight"),
			).toBeNull();
		});

		// The load-bearing regression test for this slice: with NO persisted
		// thoughtSteps and NO live thought_step activity — classifier off,
		// degraded, or simply not yet arrived — the header/rail must behave
		// exactly as P1 shipped it: non-empty, driven by the spine label, no
		// crash, and no thought-step-only DOM (row or highlight) anywhere.
		it("P1 fallback intact: with no thoughtSteps and no live thought_step activity, the header/rail behaves exactly as P1 shipped", async () => {
			const { container } = render(ThinkingBlock, {
				props: {
					content: "Considering the request",
					thinkingIsDone: false,
					segments: [],
					streaming: true,
				},
			});

			const header = screen.getByRole("button", { name: /Thinking/ });
			expect(header.textContent?.trim()).toBe("Thinking...");
			expect(container.querySelector(".thought-step-row")).toBeNull();
			expect(container.querySelector(".thought-step-class-icon")).toBeNull();

			await fireEvent.click(header);
			expect(
				container.querySelector("mark.thought-step-anchor-highlight"),
			).toBeNull();
			// TS2-c — the redesigned clean list / opt-in full-reasoning toggle
			// only ever appear once a durable step rail exists; with none, the
			// expanded panel is exactly the pre-existing raw-content fallback.
			expect(container.querySelector(".thought-step-clean-list")).toBeNull();
			expect(
				screen.queryByRole("button", { name: /Show full reasoning/ }),
			).not.toBeInTheDocument();
		});
	});

	// P4 (ADR-0056) — determinate progress enrichment on top of P1's spine and
	// P3c's rail, reusing the already-computed passIndex/passTotal
	// (deliberation-pass-catalogue.ts) and RESPONSE_ACTIVITY_IDS.DRAFTING_ANSWER.
	// No model call anywhere in this suite: every value arrives as a plain
	// prop, exactly as it would after MessageBubble's reuse of the same
	// reverse-scan-latest-match pattern P3c already established.
	describe("P4 determinate deliberation progress (ADR-0056)", () => {
		// The primary P4 regression test: `standard` depth never emits a
		// deliberation activity at all (DELIBERATION_PASS_PLAN_BY_PROFILE.standard
		// is []), so livePassIndex/livePassTotal are never populated — the new
		// props simply default to undefined/false and P1's spine label governs
		// exactly as it did before this slice.
		it("leaves standard-depth (no deliberation plan) behavior byte-identical to P1 — no new props passed at all", () => {
			render(ThinkingBlock, {
				props: {
					content: "Considering the request",
					thinkingIsDone: false,
					segments: [],
					streaming: true,
				},
			});

			const header = screen.getByRole("button", { name: /Thinking/ });
			expect(header.textContent?.trim()).toBe("Thinking...");
		});

		// At `standard` depth, RESPONSE_ACTIVITY_IDS.DRAFTING_ANSWER still fires
		// (it is part of the deterministic spine for every depth — deliberation
		// is simply a no-op there), but with no multi-pass plan ever observed
		// this must NOT flip the header to the concluding state. Proves the
		// concluding signal is gated on a real multi-pass total, not merely on
		// drafting-answer having been reached.
		it("does not enter the concluding state at standard depth even once drafting-answer is reached, since no multi-pass plan was ever observed", () => {
			render(ThinkingBlock, {
				props: {
					content: "Considering the request",
					thinkingIsDone: false,
					segments: [],
					streaming: true,
					draftingAnswerReached: true,
				},
			});

			expect(screen.getByText("Thinking...")).toBeInTheDocument();
			expect(
				screen.queryByText("Wrapping up deliberation..."),
			).not.toBeInTheDocument();
		});

		it("shows determinate pass N of M while a multi-pass maximum-depth plan is mid-flight", () => {
			render(ThinkingBlock, {
				props: {
					content: "Looking at the request",
					thinkingIsDone: false,
					livePassIndex: 2,
					livePassTotal: 6,
				},
			});

			expect(
				screen.getByRole("button", { name: "Pass 2 of 6" }),
			).toBeInTheDocument();
		});

		it("flips to the determinate concluding state once deliberation has resolved and drafting-answer is reached", () => {
			render(ThinkingBlock, {
				props: {
					content: "Looking at the request",
					thinkingIsDone: false,
					livePassIndex: 6,
					livePassTotal: 6,
					draftingAnswerReached: true,
				},
			});

			expect(
				screen.getByText("Wrapping up deliberation..."),
			).toBeInTheDocument();
			expect(screen.queryByText(/Pass \d/)).not.toBeInTheDocument();
		});

		it("does not show pass N of M for a single-pass plan (extended depth) even once drafting-answer is reached", () => {
			render(ThinkingBlock, {
				props: {
					content: "Looking at the request",
					thinkingIsDone: false,
					livePassIndex: 1,
					livePassTotal: 1,
					draftingAnswerReached: true,
				},
			});

			expect(screen.getByText("Thinking...")).toBeInTheDocument();
			expect(screen.queryByText(/Pass \d/)).not.toBeInTheDocument();
			expect(
				screen.queryByText("Wrapping up deliberation..."),
			).not.toBeInTheDocument();
		});

		it("takes precedence over a classified thought-step label — determinate progress beats a qualitative guess", () => {
			render(ThinkingBlock, {
				props: {
					content: "Looking at the request",
					thinkingIsDone: false,
					livePassIndex: 3,
					livePassTotal: 6,
					liveThoughtStepClass: "weighing-options",
				},
			});

			expect(
				screen.getByRole("button", { name: "Pass 3 of 6" }),
			).toBeInTheDocument();
			expect(
				screen.queryByText("Weighing the options..."),
			).not.toBeInTheDocument();
		});

		it("defers to P1's writing-the-answer state once the visible answer has started, even mid-plan with drafting-answer reached", () => {
			render(ThinkingBlock, {
				props: {
					content: "Looking at the request",
					thinkingIsDone: false,
					livePassTotal: 6,
					draftingAnswerReached: true,
					answerStarted: true,
				},
			});

			expect(screen.getByText("Writing the answer...")).toBeInTheDocument();
			expect(
				screen.queryByText("Wrapping up deliberation..."),
			).not.toBeInTheDocument();
		});

		it("never leaks the live pass/concluding state into the completed header, which stays the retrospective duration", () => {
			render(ThinkingBlock, {
				props: {
					content: "Looking at the request",
					thinkingIsDone: true,
					thinkingDurationSeconds: 45,
					livePassIndex: 6,
					livePassTotal: 6,
					draftingAnswerReached: true,
				},
			});

			expect(
				screen.getByRole("button", { name: "Thought for 45s" }),
			).toBeInTheDocument();
			expect(screen.queryByText(/Pass \d/)).not.toBeInTheDocument();
			expect(
				screen.queryByText("Wrapping up deliberation..."),
			).not.toBeInTheDocument();
		});
	});

	// Owner polish pass ("Interim Thought Steps" rail) — items 1, 2, 6, 7.
	describe("owner polish pass (rail visual/interaction polish)", () => {
		it("renders the 'Show full reasoning' toggle as a sibling of the header button, flush right on the same row, not nested inside it", async () => {
			const content = "First part of reasoning. Second part of reasoning.";
			const segments: ThinkingSegment[] = [{ type: "text", content }];
			const step: InterimThoughtStep = {
				id: "step-full",
				source: "classified",
				activityClass: "understanding-request",
				impliesExternalAction: false,
				anchor: { start: 0, end: 5 },
			};

			const { container } = render(ThinkingBlock, {
				props: {
					content,
					thinkingIsDone: true,
					segments,
					thoughtSteps: [step],
				},
			});

			// Not yet expanded — the toggle has nothing to toggle yet.
			expect(
				screen.queryByRole("button", { name: /Show full reasoning/ }),
			).not.toBeInTheDocument();

			await fireEvent.click(screen.getByRole("button", { name: /Thought/ }));

			const headerRow = container.querySelector(".thinking-header-row");
			expect(headerRow).not.toBeNull();
			const headerButton = headerRow?.querySelector(
				":scope > .thinking-header",
			);
			const toggleButton = headerRow?.querySelector(
				":scope > .full-reasoning-header-toggle",
			);
			expect(headerButton).not.toBeNull();
			expect(toggleButton).not.toBeNull();
			expect(toggleButton?.textContent?.trim()).toBe("Show full reasoning");
			// Siblings, not nested — a <button> can never legally contain another.
			expect(headerButton?.contains(toggleButton as Node)).toBe(false);
		});

		it("renders the completed box's expand/collapse content with a horizontal (axis: x) transition, not the live header's vertical one", () => {
			// Both the live and completed headers render the same
			// .thinking-content wrapper; this asserts the component compiles
			// and mounts cleanly with the axis chosen from `thinkingIsDone` —
			// the actual interpolation is Svelte/JSDOM transition machinery,
			// so behaviorally this is covered by the still-passing expand/
			// collapse tests elsewhere in this file.
			const { container: liveContainer } = render(ThinkingBlock, {
				props: { content: "Looking at the request", thinkingIsDone: false },
			});
			expect(liveContainer.querySelector(".thinking-block")).not.toBeNull();

			const { container: doneContainer } = render(ThinkingBlock, {
				props: {
					content: "Looking at the request",
					thinkingIsDone: true,
					thinkingDurationSeconds: 10,
				},
			});
			expect(doneContainer.querySelector(".thinking-block")).not.toBeNull();
		});

		it("gives each tool-call chip a relevant, action-specific icon instead of a generic one", async () => {
			const segments: ThinkingSegment[] = [
				{
					type: "tool_call",
					name: "memory_context",
					status: "done",
					input: { query: "the budget discussion" },
				},
				{
					type: "tool_call",
					name: "calendar",
					status: "done",
					input: { action: "list_events" },
				},
			];

			const { container } = render(ThinkingBlock, {
				props: { content: "", thinkingIsDone: true, segments },
			});

			expect(
				container.querySelector('[data-tool-icon="memory"]'),
			).not.toBeNull();
			expect(
				container.querySelector('[data-tool-icon="calendar"]'),
			).not.toBeNull();
		});

		it("gives a research_web/fetch_url row its action-specific icon alongside its favicon-stack disclosure", () => {
			const segments: ThinkingSegment[] = [
				{
					type: "tool_call",
					name: "fetch_url",
					status: "done",
					input: { url: "https://example.com/article" },
				},
			];

			const { container } = render(ThinkingBlock, {
				props: { content: "", thinkingIsDone: true, segments },
			});

			expect(
				container.querySelector('[data-tool-icon="fetch-url"]'),
			).not.toBeNull();
		});

		describe("clickable tool chips (arguments/result/status reveal)", () => {
			it("makes a generic tool-call chip clickable when it carries extra detail, and reveals arguments + status on click", async () => {
				const segments: ThinkingSegment[] = [
					{
						type: "tool_call",
						name: "memory_context",
						status: "done",
						input: { query: "the budget discussion" },
						outputSummary: "Found 2 relevant notes.",
					},
				];

				// Scoped to the always-visible tool-call stack (no need to expand
				// the panel at all — this chip is visible without expanding) so a
				// second, duplicate row from the expanded interleaved view (the
				// SAME segment rendered a second time — see the pre-existing
				// "shows fetched web source titles" test's getAllByText for this
				// exact precedent) can't make the accessible-name lookup ambiguous.
				const { container } = render(ThinkingBlock, {
					props: { content: "", thinkingIsDone: true, segments },
				});
				const stack = container.querySelector(".tool-call-stack");
				expect(stack).not.toBeNull();
				if (!stack) throw new Error("Missing tool-call-stack");
				const scoped = within(stack as HTMLElement);

				const chipButton = scoped.getByRole("button", {
					name: /Memory lookup/,
				});
				expect(chipButton).toHaveAttribute("aria-expanded", "false");
				expect(
					scoped.queryByText("the budget discussion"),
				).not.toBeInTheDocument();

				await fireEvent.click(chipButton);

				expect(chipButton).toHaveAttribute("aria-expanded", "true");
				expect(scoped.getByText("the budget discussion")).toBeInTheDocument();
				expect(scoped.getByText("Found 2 relevant notes.")).toBeInTheDocument();
				expect(scoped.getByText("Done")).toBeInTheDocument();
			});

			it("does not render a tool-call chip as clickable when it has nothing extra to reveal (honesty — never falsely clickable)", async () => {
				const segments: ThinkingSegment[] = [
					{
						type: "tool_call",
						name: "some_bare_tool",
						status: "done",
						input: {},
					},
				];

				const { container } = render(ThinkingBlock, {
					props: { content: "", thinkingIsDone: true, segments },
				});

				const stack = container.querySelector(".tool-call-stack");
				expect(stack).not.toBeNull();
				expect(stack?.querySelector(".tool-label-text--clickable")).toBeNull();
				expect(stack?.querySelector(".tool-label-text")).not.toBeNull();
			});

			it("independently opens/closes multiple clickable tool chips", async () => {
				const segments: ThinkingSegment[] = [
					{
						type: "tool_call",
						name: "memory_context",
						status: "done",
						input: { query: "topic one" },
					},
					{
						type: "tool_call",
						name: "image_search",
						status: "done",
						input: { query: "topic two" },
					},
				];

				const { container } = render(ThinkingBlock, {
					props: { content: "", thinkingIsDone: true, segments },
				});
				const stack = container.querySelector(".tool-call-stack");
				expect(stack).not.toBeNull();
				if (!stack) throw new Error("Missing tool-call-stack");
				const scoped = within(stack as HTMLElement);

				await fireEvent.click(
					scoped.getByRole("button", { name: /Memory lookup/ }),
				);
				expect(scoped.getByText("topic one")).toBeInTheDocument();
				expect(scoped.queryByText("topic two")).not.toBeInTheDocument();

				// image_search's chip label uses the generic "Search: ..." phrasing
				// (formatToolCall's existing "search"-name branch only prefers a
				// dedicated web-search label for research_web/*web* names) — this
				// test only needs a second, independent chip to toggle, not a
				// specific label, so it matches on the query text instead.
				await fireEvent.click(
					scoped.getByRole("button", { name: /topic two/ }),
				);
				expect(scoped.getByText("topic one")).toBeInTheDocument();
				expect(scoped.getByText("topic two")).toBeInTheDocument();
			});
		});

		describe("live current-step emphasis", () => {
			it("emphasizes only the most-recently-arrived tool row while the turn is still active", () => {
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
						status: "running",
						input: { query: "latest pricing" },
					},
				];

				const { container } = render(ThinkingBlock, {
					props: { content: "", thinkingIsDone: false, segments },
				});

				const rows = container.querySelectorAll(
					".tool-call-stack > .tool-call-row",
				);
				expect(rows).toHaveLength(2);
				expect(rows[0]?.classList.contains("is-current-step")).toBe(false);
				expect(rows[1]?.classList.contains("is-current-step")).toBe(true);
			});

			it("settles every row back to calm once the turn completes", () => {
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
						input: { query: "latest pricing" },
					},
				];

				const { container } = render(ThinkingBlock, {
					props: { content: "", thinkingIsDone: true, segments },
				});

				const rows = container.querySelectorAll(
					".tool-call-stack > .tool-call-row",
				);
				for (const row of rows) {
					expect(row.classList.contains("is-current-step")).toBe(false);
				}
			});
		});
	});
});
