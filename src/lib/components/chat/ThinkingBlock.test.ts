import {
	act,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import type { InterimThoughtStep } from "$lib/response-activity-types";
import type { ThinkingSegment } from "$lib/server/services/messages-types";
import ThinkingBlock from "./ThinkingBlock.svelte";

/**
 * The activity body's leading eyebrow ("Sources · 1 cited", "Program", ...),
 * with template whitespace collapsed so the assertion reads as the rendered
 * sentence rather than the markup's indentation.
 */
function eyebrowText(): string | undefined {
	return document
		.querySelector(".act-eyebrow")
		?.textContent?.replace(/\s+/g, " ")
		.trim();
}

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
		// Open the read-page activity row to reveal its source rows.
		await fireEvent.click(screen.getByTestId("tool-activity-row"));
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

	it("groups active comma-separated URL fetch inputs behind one read-page activity row", async () => {
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
		// Both URLs ride one read row, not one row each.
		const rows = screen.getAllByTestId("tool-activity-row");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toHaveTextContent("Reading");

		await fireEvent.click(rows[0] as HTMLElement);
		const links = screen.getAllByRole("link", { name: /(?:a|b)\.example/ });
		expect(links).toHaveLength(2);
		expect(links[0]).toHaveAttribute("href", "https://a.example/x");
		expect(links[1]).toHaveAttribute("href", "https://b.example/y");
		expect(document.querySelectorAll(".act-favicon img")).toHaveLength(2);
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
		// The same call renders once in the live stack and once in the
		// expanded rail; both are the same compact row.
		const rows = screen.getAllByTestId("tool-activity-row");
		expect(rows).toHaveLength(2);
		const [firstRow] = rows;
		if (!firstRow) throw new Error("Missing tool activity row");
		expect(firstRow).toHaveTextContent("Searching");
		expect(firstRow).toHaveTextContent("latest pricing");
		expect(firstRow).toHaveTextContent("1 source");
		await fireEvent.click(firstRow);
		expect(
			screen.getAllByRole("link", { name: /Widget Pro Store Page/ }).length,
		).toBeGreaterThan(0);
		expect(
			document.querySelectorAll(".act-favicon img").length,
		).toBeGreaterThan(0);
		expect(
			screen.queryByText('Searching: "latest pricing"'),
		).not.toBeInTheDocument();
	});

	// ADR-0061 — a message persisted before the thinking-toggle redesign can
	// still carry the now-retired Normal Chat Deliberation Passes fields
	// (passIndex/passTotal/passKind) on a status thinking segment in its stored
	// JSON. These are not part of the current ThinkingSegment type and are not
	// re-validated at read time — the component must simply ignore them and
	// render the segment as a normal completed status row, never crash.
	it("tolerates legacy passIndex/passTotal/passKind fields on a persisted status segment without crashing", async () => {
		const segments: ThinkingSegment[] = [
			{
				type: "status",
				id: "deliberation-pass-1",
				status: "done",
				label: "Reviewed context and sources",
				passIndex: 1,
				passTotal: 6,
				passKind: "context_source_gap_review",
			} as never,
		];

		expect(() =>
			render(ThinkingBlock, {
				props: {
					content: "",
					thinkingIsDone: true,
					segments,
				},
			}),
		).not.toThrow();

		await fireEvent.click(screen.getByRole("button", { name: /Thought/ }));
		expect(
			screen.getByText("Reviewed context and sources"),
		).toBeInTheDocument();
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

		// Stack view: one grouped calendar row (count 6), not six rows.
		const stackRows = screen.getAllByTestId("tool-activity-row");
		expect(stackRows).toHaveLength(2);
		const groupRow = stackRows[0] as HTMLElement;
		expect(groupRow).toHaveTextContent("Calendar");
		expect(groupRow).toHaveTextContent("6 actions");
		expect(screen.queryByText(/Calendar: list events/)).not.toBeInTheDocument();
		expect(stackRows[1]).toHaveTextContent("Searched");
		expect(stackRows[1]).toHaveTextContent("weather forecast");

		// Running affordance: one call in the group is still running.
		expect(groupRow.classList.contains("is-running")).toBe(true);
		expect(groupRow.getAttribute("data-status")).toBe("running");
		expect(groupRow.querySelector(".act-status.running")).not.toBeNull();

		// Expand the group to reveal the individual actions.
		await fireEvent.click(groupRow);
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
		expect(
			screen
				.getAllByTestId("tool-activity-row")
				.filter((row) => row.getAttribute("data-icon-type") === "calendar"),
		).toHaveLength(2);

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
		const doneGroupRow = container.querySelector(
			'[data-testid="tool-activity-stack"] [data-icon-type="calendar"]',
		);
		expect(doneGroupRow?.textContent).toContain("Calendar");
		expect(doneGroupRow?.textContent).toContain("6 actions");
		expect(doneGroupRow?.classList.contains("is-running")).toBe(false);
		expect(doneGroupRow?.getAttribute("data-status")).toBe("done");
		const doneGlyph = doneGroupRow?.querySelector(".act-status");
		expect(doneGlyph).not.toBeNull();
		expect(doneGlyph?.classList.contains("running")).toBe(false);
		expect(doneGlyph?.classList.contains("failed")).toBe(false);
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
			'[data-testid="tool-activity-stack"] [data-testid="tool-activity-row"]',
		);
		expect(stackRows).toHaveLength(3);
		expect(stackRows[0]?.textContent).toContain("Calendar");
		expect(stackRows[0]?.textContent).toContain("1 action");
		expect(stackRows[1]?.textContent).toContain("Searched");
		expect(stackRows[1]?.textContent).toContain("weather forecast");
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

		const row = screen.getByTestId("tool-activity-row");
		expect(row).toHaveTextContent("Searched");
		expect(row).toHaveTextContent("1 source");
		await fireEvent.click(row);
		// The source row names the page and then its host, so match on the
		// title rather than the whole accessible name.
		const links = screen.getAllByRole("link", {
			name: /Widget Pro Store Page/,
		});
		expect(links.length).toBeGreaterThan(0);
		const [link] = links;
		if (!link) throw new Error("Missing fetched source link");
		expect(link).toHaveAttribute(
			"href",
			"https://shop.example.com/products/widget-pro",
		);
		expect(
			document.querySelectorAll(".act-favicon img").length,
		).toBeGreaterThan(0);
		expect(
			screen.queryByText('Searching: "latest pricing"'),
		).not.toBeInTheDocument();
	});

	// C1 cited-first redesign, restyled as a line-by-line source list inside
	// the row's opened body: cited (status "selected") sources lead and carry
	// the accent check; uncited ("reference") sources follow, plain; the
	// body's eyebrow counts cites and the row's meta counts sources.
	describe("cited-aware web sources", () => {
		it("orders cited sources first and marks them", async () => {
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

			await fireEvent.click(screen.getByRole("button", { name: /Thought/ }));

			// The row's meta counts the sources...
			const row = screen.getByTestId("tool-activity-row");
			expect(row).toHaveTextContent("2 sources");
			await fireEvent.click(row);

			// ...and the opened body's eyebrow reflects the citation count.
			expect(eyebrowText()).toBe("Sources · 1 cited");

			const results = document.querySelectorAll(".act-src");
			expect(results).toHaveLength(2);

			// Cited leads, marked with the accent check.
			expect(results[0]?.textContent).toContain("Cited Source");
			expect(results[0]?.classList.contains("is-cited")).toBe(true);
			expect(results[0]?.querySelector(".act-src-cited")).not.toBeNull();

			// Uncited follows, unmarked.
			expect(results[1]?.textContent).toContain("Uncited Source");
			expect(results[1]?.classList.contains("is-cited")).toBe(false);
			expect(results[1]?.querySelector(".act-src-cited")).toBeNull();
		});

		it("omits the cited suffix when nothing was cited", async () => {
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

			await fireEvent.click(screen.getByRole("button", { name: /Thought/ }));

			const row = screen.getByTestId("tool-activity-row");
			expect(row).toHaveTextContent("1 source");
			await fireEvent.click(row);

			expect(eyebrowText()).toBe("Sources");
			expect(screen.queryByText(/cited/i)).toBeNull();
			expect(document.querySelector(".act-src-cited")).toBeNull();
		});

		it("shows the title inline and the reason in the row's native tooltip", async () => {
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

			await fireEvent.click(screen.getByRole("button", { name: /Thought/ }));
			await fireEvent.click(screen.getByTestId("tool-activity-row"));

			const result = document.querySelector(".act-src");
			// The title shows inline on the row (no hover-only card to clip it).
			expect(result?.textContent).toContain("Cited Source");
			// The compact reason rides the row's native title tooltip.
			expect(result?.getAttribute("title")).toContain(
				"Why this source matters.",
			);
			// The row links straight out to the source.
			expect(result?.getAttribute("href")).toBe("https://cited.example/y");
		});

		it("marks no row as cited when nothing was cited", async () => {
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

			await fireEvent.click(screen.getByRole("button", { name: /Thought/ }));
			await fireEvent.click(screen.getByTestId("tool-activity-row"));

			const results = document.querySelectorAll(".act-src");
			expect(results).toHaveLength(2);
			// With zero cited sources, no row carries the cited marker.
			for (const result of results) {
				expect(result.classList.contains("is-cited")).toBe(false);
				expect(result.querySelector(".act-src-cited")).toBeNull();
			}
		});

		it("renders read-page (fetch_url) results as plain rows, none cited", async () => {
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

			await fireEvent.click(screen.getByRole("button", { name: /Thought/ }));
			await fireEvent.click(screen.getByTestId("tool-activity-row"));

			const results = document.querySelectorAll(".act-src");
			expect(results).toHaveLength(2);
			for (const result of results) {
				expect(result.classList.contains("is-cited")).toBe(false);
				expect(result.querySelector(".act-src-cited")).toBeNull();
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

			await fireEvent.click(screen.getByRole("button", { name: /Thought/ }));

			// The two copies collapse to one source, counted as cited.
			const row = screen.getByTestId("tool-activity-row");
			expect(row).toHaveTextContent("1 source");
			await fireEvent.click(row);
			expect(eyebrowText()).toBe("Sources · 1 cited");

			const results = document.querySelectorAll(".act-src");
			expect(results).toHaveLength(1);
			// The surviving copy is the cited one, not the reference dropped first.
			expect(results[0]?.textContent).toContain("Cited Copy");
			expect(results[0]?.classList.contains("is-cited")).toBe(true);
		});

		it("shows every source as its own row — no '+N' fold even for a long tail", async () => {
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

			await fireEvent.click(screen.getByRole("button", { name: /Thought/ }));

			const row = screen.getByTestId("tool-activity-row");
			expect(row).toHaveTextContent("10 sources");
			await fireEvent.click(row);
			expect(eyebrowText()).toBe("Sources · 1 cited");

			// All 10 render as rows; nothing is folded behind a "+N" reveal.
			const results = document.querySelectorAll(".act-src");
			expect(results).toHaveLength(10);
			expect(screen.queryByText("+3")).toBeNull();
			// The very tail of the list is a real row, not a fold affordance.
			expect(screen.getByText("Uncited 8")).toBeInTheDocument();
		});
	});

	// Tier 0 (2026-08-22 chat-experience-elevation plan §3), as carried into
	// the unified activity row: the row leads with its status glyph AND its
	// per-tool identity icon (the mockup's icon column), the opened source
	// list is a SIBLING panel below the row (never wrapped inside it, so the
	// row can't jump on toggle), and each source row re-exposes its full
	// excerpt in an un-clipped hover popover.
	describe("Tier 0 research_web open-dropdown corrections", () => {
		it("renders the web-search identity icon alongside the status tick on a research_web row", async () => {
			const segments: ThinkingSegment[] = [
				{
					type: "tool_call",
					name: "research_web",
					status: "done",
					input: { query: "pricing" },
					sourceType: "web",
					candidates: [
						{
							id: "s1",
							title: "Source One",
							url: "https://one.example/",
							sourceType: "web",
							status: "selected",
						},
					],
				},
			];

			const { container } = render(ThinkingBlock, {
				props: { content: "", thinkingIsDone: true, segments },
			});

			await fireEvent.click(screen.getByRole("button", { name: /Thought/ }));

			const row = container.querySelector('[data-testid="tool-activity-row"]');
			expect(row).not.toBeNull();
			// The Globe identity icon names the tool in the row's icon column...
			expect(
				row?.querySelector('[data-tool-icon="web-search"]'),
			).not.toBeNull();
			// ...and the status glyph (done → check) leads it.
			const glyph = row?.querySelector(".act-status");
			expect(glyph).not.toBeNull();
			expect(glyph?.classList.contains("running")).toBe(false);
			expect(glyph?.classList.contains("failed")).toBe(false);
		});

		it("renders the opened results panel as a sibling of the activity row, not a descendant", async () => {
			const segments: ThinkingSegment[] = [
				{
					type: "tool_call",
					name: "research_web",
					status: "done",
					input: { query: "pricing" },
					sourceType: "web",
					candidates: [
						{
							id: "s1",
							title: "Source One",
							url: "https://one.example/",
							sourceType: "web",
							status: "selected",
						},
					],
				},
			];

			render(ThinkingBlock, {
				props: { content: "", thinkingIsDone: true, segments },
			});

			await fireEvent.click(screen.getByRole("button", { name: /Thought/ }));
			await fireEvent.click(screen.getByTestId("tool-activity-row"));

			// Fix B — the panel exists in the document...
			expect(screen.getByTestId("tool-activity-body")).toBeInTheDocument();
			// ...but is NOT nested inside the row: it's a full-width sibling
			// rendered after the row inside .act-entry, so the row (and its
			// glyph) stays a stable single line and never grows/moves on toggle.
			expect(
				screen
					.getByTestId("tool-activity-row")
					.querySelector('[data-testid="tool-activity-body"]'),
			).toBeNull();
		});

		it("exposes each result's full excerpt in a hover popover, untruncated", async () => {
			const longReason =
				"This retailer lists the current pricing tiers in detail, including the enterprise plan and the per-seat monthly cost, which is exactly what the question asked about, spelled out in full without any elision.";
			const segments: ThinkingSegment[] = [
				{
					type: "tool_call",
					name: "research_web",
					status: "done",
					input: { query: "pricing" },
					sourceType: "web",
					candidates: [
						{
							id: "s1",
							title: "Pricing Page",
							url: "https://shop.example/pricing",
							sourceType: "web",
							status: "selected",
							snippet: longReason,
						},
					],
				},
			];

			render(ThinkingBlock, {
				props: { content: "", thinkingIsDone: true, segments },
			});

			await fireEvent.click(screen.getByRole("button", { name: /Thought/ }));
			await fireEvent.click(screen.getByTestId("tool-activity-row"));

			const result = document.querySelector(".act-src");
			expect(result).not.toBeNull();
			// Fix D — a per-row popover element carries the title + full excerpt.
			const popover = result?.querySelector(".act-src-popover");
			expect(popover).not.toBeNull();
			expect(
				popover?.querySelector(".act-src-popover-title")?.textContent,
			).toBe("Pricing Page");
			expect(
				popover?.querySelector(".act-src-popover-reason")?.textContent,
			).toBe(longReason);
			// The excerpt is present in full — never truncated by the popover.
			expect(popover?.textContent).toContain(longReason);
			// a11y: the visual popover is hidden from the accessibility tree so its
			// excerpt never pollutes the link's accessible name (it opens on
			// :focus-within / :focus-visible). The native `title` attr is the sole
			// a11y channel for the reason.
			expect(popover?.getAttribute("aria-hidden")).toBe("true");
			// The native title attr stays as the non-hover / a11y fallback.
			expect(result?.getAttribute("title")).toContain(longReason);
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

			// Scoped to the strip's own label — the connector group's row verb
			// reads "Photos" too, so a bare text lookup would be ambiguous.
			expect(
				document.querySelector(".photo-strip .peek-label")?.textContent,
			).toBe("Photos");
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
		it("renders a failed tool call distinctly from a done one in the live stack", () => {
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
				props: { content: "", thinkingIsDone: false, segments },
			});

			const row = container.querySelector('[data-testid="tool-activity-row"]');
			expect(row).not.toBeNull();
			expect(row?.classList.contains("is-failed")).toBe(true);
			expect(row?.classList.contains("is-running")).toBe(false);
			expect(row?.getAttribute("data-status")).toBe("failed");
			expect(row?.querySelector(".act-status.failed")).not.toBeNull();
			expect(row?.querySelector(".act-status.running")).toBeNull();
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

			const item = document.querySelector(
				'.interleaved-rail [data-testid="tool-activity-row"]',
			);
			expect(item).not.toBeNull();
			expect(item?.classList.contains("is-failed")).toBe(true);
			expect(item?.getAttribute("data-status")).toBe("failed");
			expect(item?.querySelector(".act-status.failed")).not.toBeNull();
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
				props: { content: "", thinkingIsDone: false, segments },
			});

			const row = container.querySelector('[data-testid="tool-activity-row"]');
			expect(row).not.toBeNull();
			expect(row?.classList.contains("is-failed")).toBe(false);
			expect(row?.getAttribute("data-status")).toBe("done");
			expect(row?.querySelector(".act-status")).not.toBeNull();
			expect(row?.querySelector(".act-status.failed")).toBeNull();
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
				props: { content: "", thinkingIsDone: false, segments },
			});

			const groupRow = container.querySelector(
				'[data-testid="tool-activity-row"]',
			);
			expect(groupRow).not.toBeNull();
			expect(groupRow?.classList.contains("is-failed")).toBe(true);
			expect(groupRow?.getAttribute("data-status")).toBe("failed");
			expect(groupRow?.querySelector(".act-status.failed")).not.toBeNull();
			// The group-level "Failed" fact rides the row itself (not only the
			// per-action list revealed below it).
			expect(groupRow?.querySelector(".act-meta")?.textContent).toBe("Failed");

			// Expanding the group shows exactly which action failed.
			await fireEvent.click(groupRow as HTMLElement);
			const actionItems = document.querySelectorAll(
				'[data-testid="tool-activity-action"]',
			);
			expect(actionItems).toHaveLength(2);
			expect(actionItems[0]?.querySelector(".act-status.failed")).toBeNull();
			expect(
				actionItems[1]?.querySelector(".act-status.failed"),
			).not.toBeNull();
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
		// means there are no status segments and no tool_call segments either —
		// segments stays empty for the whole turn, exactly like this fixture.
		// The rail must still never be empty.
		it("never renders an empty header for a standard-depth turn with no tool calls", () => {
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
		// list (steps + tool activity rows, in true arrival order), and the raw
		// reasoning prose the old "mess" dumped inline is gone from the
		// default view entirely.
		it("shows a compact clean list of steps and a distinct tool activity row, in the order they actually occurred, with no raw reasoning prose", async () => {
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
				".thought-step-clean-list > .thought-step-row, .thought-step-clean-list > .act-entry",
			);
			expect(rows).toHaveLength(3);
			expect(rows[0]?.className).toContain("thought-step-row");
			expect(rows[0]?.textContent).toContain("Understanding the request...");
			expect(rows[1]?.className).toContain("act-entry");
			expect(
				rows[1]?.querySelector('[data-testid="tool-activity-row"]'),
			).not.toBeNull();
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
			// The highlight is still EXACTLY the anchored span.
			expect(mark?.textContent).toBe(anchorText);
			// The reveal now completes the sentence the span sits in, so it no
			// longer begins/ends mid-sentence: the same-sentence lead-in ("Then
			// I ") and tail ("before continuing.") surround the highlight...
			const reveal = mark?.closest("pre");
			expect(reveal?.textContent).toBe(
				"Then I weighed two different options before continuing.",
			);
			// ...but the PREVIOUS sentence is not pulled in.
			expect(reveal?.textContent).not.toContain("First I read the request");
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

		it("mounts the same expand/collapse content wrapper whether the turn is live or complete", () => {
			// Both the live and completed headers render the same
			// .thinking-content wrapper, which slides open and closed on the
			// vertical axis; this asserts the component compiles and mounts
			// cleanly in both states — the actual interpolation is
			// Svelte/JSDOM transition machinery, so behaviorally this is
			// covered by the still-passing expand/collapse tests elsewhere in
			// this file.
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

		it("gives each tool-call row a relevant, action-specific icon instead of a generic one", () => {
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
				props: { content: "", thinkingIsDone: false, segments },
			});

			const rows = container.querySelectorAll(
				'[data-testid="tool-activity-stack"] [data-testid="tool-activity-row"]',
			);
			expect(rows).toHaveLength(2);
			expect(
				rows[0]?.querySelector('[data-tool-icon="memory"]'),
			).not.toBeNull();
			expect(
				rows[1]?.querySelector('[data-tool-icon="calendar"]'),
			).not.toBeNull();
			expect(container.querySelector('[data-tool-icon="generic"]')).toBeNull();
		});

		it("renders the fetch-url identity icon alongside the status tick on a fetch_url row", () => {
			const segments: ThinkingSegment[] = [
				{
					type: "tool_call",
					name: "fetch_url",
					status: "done",
					input: { url: "https://example.com/article" },
				},
			];

			const { container } = render(ThinkingBlock, {
				props: { content: "", thinkingIsDone: false, segments },
			});

			const row = container.querySelector(
				'[data-testid="tool-activity-stack"] [data-testid="tool-activity-row"]',
			);
			expect(row).not.toBeNull();
			// The Link identity icon names the tool in the row's icon column
			// (symmetry with the web-search globe).
			expect(row?.querySelector('[data-tool-icon="fetch-url"]')).not.toBeNull();
			// The status glyph still leads the row.
			const glyph = row?.querySelector(".act-status");
			expect(glyph).not.toBeNull();
			expect(glyph?.classList.contains("running")).toBe(false);
			expect(glyph?.classList.contains("failed")).toBe(false);
		});

		describe("clickable tool rows (arguments/result reveal)", () => {
			it("makes a generic tool-call row clickable when it carries extra detail, and reveals arguments + result on click (no redundant status row — progress/done is already shown by the row itself)", async () => {
				// A tool with no per-tool row grammar of its own, so the generic
				// arguments/result panel is really what is under test. `scope`
				// is the row's own object; `detail` only ever appears in the
				// body, which is what makes the reveal observable.
				const segments: ThinkingSegment[] = [
					{
						type: "tool_call",
						name: "some_new_tool",
						status: "done",
						input: { scope: "quarterly", detail: "the budget discussion" },
						outputSummary: "Found 2 relevant notes.",
					},
				];

				// Scoped to the live activity stack (no need to expand the panel
				// at all — this row is visible without expanding) so a second,
				// duplicate row from the expanded interleaved view (the SAME
				// segment rendered a second time — see the pre-existing "shows
				// fetched web source titles" test for this exact precedent)
				// can't make the accessible-name lookup ambiguous.
				const { container } = render(ThinkingBlock, {
					props: { content: "", thinkingIsDone: false, segments },
				});
				const stack = container.querySelector(
					'[data-testid="tool-activity-stack"]',
				);
				expect(stack).not.toBeNull();
				if (!stack) throw new Error("Missing tool activity stack");
				const scoped = within(stack as HTMLElement);

				const rowButton = scoped.getByRole("button", {
					name: /quarterly/,
				});
				expect(rowButton).toHaveAttribute("aria-expanded", "false");
				expect(
					scoped.queryByText("the budget discussion"),
				).not.toBeInTheDocument();

				await fireEvent.click(rowButton);

				expect(rowButton).toHaveAttribute("aria-expanded", "true");
				expect(scoped.getByText("Arguments")).toBeInTheDocument();
				expect(scoped.getByText("the budget discussion")).toBeInTheDocument();
				expect(scoped.getByText("Result")).toBeInTheDocument();
				expect(scoped.getByText("Found 2 relevant notes.")).toBeInTheDocument();
				// The Status sub-section was removed: it only ever said "Running"
				// or "Done", which the row's own state already conveys.
				expect(scoped.queryByText("Status")).not.toBeInTheDocument();
				expect(scoped.queryByText("Done")).not.toBeInTheDocument();
			});

			it("does not render a tool-call row as clickable when it has nothing extra to reveal (honesty — never falsely clickable)", () => {
				const segments: ThinkingSegment[] = [
					{
						type: "tool_call",
						name: "some_bare_tool",
						status: "done",
						input: {},
					},
				];

				const { container } = render(ThinkingBlock, {
					props: { content: "", thinkingIsDone: false, segments },
				});

				const stack = container.querySelector(
					'[data-testid="tool-activity-stack"]',
				);
				expect(stack).not.toBeNull();
				// With no body to reveal the row is a plain <div>, never a button,
				// and it carries no chevron to promise a disclosure.
				expect(
					stack?.querySelector('button[data-testid="tool-activity-row"]'),
				).toBeNull();
				expect(
					stack?.querySelector('div[data-testid="tool-activity-row"]'),
				).not.toBeNull();
				expect(stack?.querySelector(".act-chevron")).toBeNull();
			});

			it("independently opens/closes multiple clickable tool rows", async () => {
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
					props: { content: "", thinkingIsDone: false, segments },
				});
				const stack = container.querySelector(
					'[data-testid="tool-activity-stack"]',
				);
				expect(stack).not.toBeNull();
				if (!stack) throw new Error("Missing tool activity stack");
				const scoped = within(stack as HTMLElement);

				await fireEvent.click(scoped.getByRole("button", { name: /Recalled/ }));
				// Only the memory row's body opened; its neighbour stays closed.
				expect(scoped.getAllByTestId("tool-activity-body")).toHaveLength(1);
				expect(scoped.getByTestId("tool-activity-body").textContent).toContain(
					"topic one",
				);

				// The image-search row carries its query as the row object, so it
				// is matched by its own verb — this test only needs a second,
				// independent row to toggle.
				await fireEvent.click(
					scoped.getByRole("button", { name: /Searched images/ }),
				);
				const bodies = scoped.getAllByTestId("tool-activity-body");
				expect(bodies).toHaveLength(2);
				expect(bodies[0]?.textContent).toContain("topic one");
				expect(bodies[1]?.textContent).toContain("topic two");
			});
		});
	});

	describe("Answer now", () => {
		it("shows the button while reasoning is live and no answer has started", () => {
			render(ThinkingBlock, {
				props: {
					content: "Working through the request.",
					thinkingIsDone: false,
					answerStarted: false,
					onAnswerNow: vi.fn(),
				},
			});

			expect(
				screen.getByRole("button", { name: "Answer now" }),
			).toBeInTheDocument();
		});

		it("does not render the button when no onAnswerNow handler is supplied", () => {
			render(ThinkingBlock, {
				props: {
					content: "Working through the request.",
					thinkingIsDone: false,
					answerStarted: false,
				},
			});

			expect(
				screen.queryByRole("button", { name: "Answer now" }),
			).not.toBeInTheDocument();
		});

		it("hides the button once the visible answer has started", async () => {
			const { rerender } = render(ThinkingBlock, {
				props: {
					content: "Working through the request.",
					thinkingIsDone: false,
					answerStarted: false,
					onAnswerNow: vi.fn(),
				},
			});

			expect(
				screen.getByRole("button", { name: "Answer now" }),
			).toBeInTheDocument();

			await rerender({
				content: "Working through the request.",
				thinkingIsDone: false,
				answerStarted: true,
				onAnswerNow: vi.fn(),
			});

			expect(
				screen.queryByRole("button", { name: "Answer now" }),
			).not.toBeInTheDocument();
		});

		it("hides the button once the message has completed", () => {
			render(ThinkingBlock, {
				props: {
					content: "Working through the request.",
					thinkingIsDone: true,
					answerStarted: false,
					onAnswerNow: vi.fn(),
				},
			});

			expect(
				screen.queryByRole("button", { name: "Answer now" }),
			).not.toBeInTheDocument();
		});

		it("calls onAnswerNow when clicked", async () => {
			const onAnswerNow = vi.fn();
			render(ThinkingBlock, {
				props: {
					content: "Working through the request.",
					thinkingIsDone: false,
					answerStarted: false,
					onAnswerNow,
				},
			});

			await fireEvent.click(screen.getByRole("button", { name: "Answer now" }));

			expect(onAnswerNow).toHaveBeenCalledTimes(1);
		});
	});
});
