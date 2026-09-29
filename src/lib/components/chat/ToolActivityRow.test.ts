import { readFileSync } from "node:fs";
import { fireEvent, render, within } from "@testing-library/svelte";
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

	// The in-chat card for Document/App/Canvas/Slides (cross-kind task, after
	// Slice 1's merge): a successful create_artifact/edit_artifact renders
	// ArtifactCard as this row's body, for every kind — a refused or failed
	// call never does.
	describe("create_artifact / edit_artifact — the in-chat card", () => {
		function artifactSegment(overrides: Partial<ToolCallSegment> = {}) {
			return toolCall({
				name: "create_artifact",
				input: { artifactType: "document", title: "Weekend plan" },
				status: "done",
				metadata: {
					ok: true,
					artifactId: "artifact-1",
					artifactKind: "document",
					artifactTitle: "Weekend plan",
				},
				...overrides,
			});
		}

		it("renders the card, already open, for a successful create_artifact — one card per kind", () => {
			const kinds: Array<"document" | "app" | "canvas" | "slides"> = [
				"document",
				"app",
				"canvas",
				"slides",
			];
			for (const kind of kinds) {
				const { getByTestId, unmount } = render(ToolActivityRow, {
					item: buildToolActivityItem(
						artifactSegment({
							metadata: {
								ok: true,
								artifactId: `artifact-${kind}`,
								artifactKind: kind,
								artifactTitle: `My ${kind}`,
							},
						}),
						`row-${kind}`,
						get(t),
					),
				});
				expect(getByTestId("artifact-card")).toBeInTheDocument();
				// The title lives on the row's own line — chrome="body" draws no
				// title of its own (see the "does not repeat the title" test
				// below), so the card is identified by its testid, not by text
				// that would otherwise be duplicated.
				expect(getByTestId("tool-activity-row")).toHaveTextContent(
					`My ${kind}`,
				);
				unmount();
			}
		});

		// Wave 2.5 Step 12 deliberately overturns slice-0's old "no title of its
		// own" contract for THIS chrome (chrome="body" → chrome="full"): the
		// approved mockup's `.a-card` repeats the title on purpose — once on
		// the tool row's compact status line, once on the card's own head — so
		// the card reads as a standalone deliverable next to the chat rather
		// than a nested log entry. See ArtifactCard.svelte's header comment.
		// (chrome="body" itself is untouched: the File kind's own "exactly
		// once" contract, covered elsewhere in this file, still holds.)
		it("repeats the title once on the row's compact line and once on the standalone card's own head", () => {
			const { container, getByTestId } = render(ToolActivityRow, {
				item: buildToolActivityItem(artifactSegment(), "row-title", get(t)),
			});
			// The row's own line already reads "Created Weekend plan" (verb +
			// object) — ToolActivityRow's rowContents() always renders it.
			expect(getByTestId("tool-activity-row")).toHaveTextContent(
				"Weekend plan",
			);
			// The standalone card renders through its own wrapper, never inside
			// the row-joined `.act-body` (Wave 2.5 Step 12).
			expect(getByTestId("tool-activity-standalone-card")).toBeInTheDocument();
			expect(within(container).getAllByText("Weekend plan")).toHaveLength(2);
		});

		it("renders no card for a refused edit_artifact — the row still shows what happened", () => {
			const { queryByTestId, getByTestId } = render(ToolActivityRow, {
				item: buildToolActivityItem(
					artifactSegment({
						name: "edit_artifact",
						status: "done",
						outputSummary: "Apps are not edited in place.",
						metadata: {
							ok: false,
							artifactId: "artifact-1",
							artifactKind: "app",
						},
					}),
					"row-refused",
					get(t),
				),
				open: true,
			});
			expect(queryByTestId("artifact-card")).not.toBeInTheDocument();
			expect(getByTestId("tool-activity-row")).toBeInTheDocument();
		});

		it("Open builds a minimal ready-to-open item from the card's own metadata and passes the conversation id", async () => {
			const onOpenDocument = vi.fn();
			const { getByTestId } = render(ToolActivityRow, {
				item: buildToolActivityItem(artifactSegment(), "row-open", get(t)),
				onOpenDocument,
				conversationId: "conv-42",
			});

			// chrome="full"'s head is one button (redesign §5.2), so its
			// accessible name is the whole head's text, not the bare word
			// "Open" — click by the head's own testid instead.
			await fireEvent.click(getByTestId("artifact-card-head"));

			expect(onOpenDocument).toHaveBeenCalledWith(
				expect.objectContaining({
					artifactId: "artifact-1",
					kind: "document",
					title: "Weekend plan",
					conversationId: "conv-42",
				}),
			);
		});

		// Redesign §5.2, Wave 2.5 Step 12: "after an edit ... 'Review ›'" —
		// mirrors `DocumentWorkspace.svelte`'s own `pendingReviewCount` formula
		// exactly (same ephemeral `alfyActivity` signal, matched by artifactId).
		it("shows the pending-review pill and 'Review' when alfyActivity is about this card's own artifact", () => {
			const { getByTestId } = render(ToolActivityRow, {
				item: buildToolActivityItem(artifactSegment(), "row-review", get(t)),
				alfyActivity: {
					key: "call-1",
					artifactId: "artifact-1",
					toolName: "edit_artifact",
					status: "applied",
					label: null,
					patches: [],
					refusedBlocks: [],
					appliedCount: 2,
				},
			});

			const head = getByTestId("artifact-card-head");
			expect(head).toHaveTextContent("2 changes to review");
			expect(head).toHaveTextContent("Review");
		});

		// Redesign §4.2 "The chat side", Wave 2.5 Step 11: the two pills are
		// independent signals shown side by side.
		it("shows both the pending-review and left-alone pills for a partial refusal", () => {
			const { getByTestId } = render(ToolActivityRow, {
				item: buildToolActivityItem(artifactSegment(), "row-partial", get(t)),
				alfyActivity: {
					key: "call-1",
					artifactId: "artifact-1",
					toolName: "edit_artifact",
					status: "refused",
					label: null,
					patches: [],
					refusedBlocks: [{ blockId: "p2", reason: "block_changed" }],
					appliedCount: 1,
				},
			});

			const head = getByTestId("artifact-card-head");
			expect(head).toHaveTextContent("1 change to review");
			expect(head).toHaveTextContent("1 part left alone");
			expect(head).toHaveTextContent("Review");
		});

		// A fully refused call has nothing applied — the card must not claim
		// "N changes to review" for zero applied changes (the old
		// `Math.max(appliedCount, 1)` stopgap this pill replaces did).
		it("shows only the left-alone pill, still with 'Review', for a full refusal", () => {
			const { getByTestId } = render(ToolActivityRow, {
				item: buildToolActivityItem(
					artifactSegment(),
					"row-full-refusal",
					get(t),
				),
				alfyActivity: {
					key: "call-1",
					artifactId: "artifact-1",
					toolName: "edit_artifact",
					status: "refused",
					label: null,
					patches: [],
					refusedBlocks: [{ blockId: "p1", reason: "block_changed" }],
					appliedCount: 0,
				},
			});

			const head = getByTestId("artifact-card-head");
			expect(head).not.toHaveTextContent("change to review");
			expect(head).toHaveTextContent("1 part left alone");
			expect(head).toHaveTextContent("Review");
		});

		it("ignores alfyActivity about a DIFFERENT artifact", () => {
			const { getByTestId } = render(ToolActivityRow, {
				item: buildToolActivityItem(artifactSegment(), "row-other", get(t)),
				alfyActivity: {
					key: "call-1",
					artifactId: "some-other-artifact",
					toolName: "edit_artifact",
					status: "applied",
					label: null,
					patches: [],
					refusedBlocks: [],
					appliedCount: 2,
				},
			});

			const head = getByTestId("artifact-card-head");
			expect(head).not.toHaveTextContent("changes to review");
			expect(head).toHaveTextContent("Open");
		});

		// Wave 2.5 Step 13: wires ArtifactCardView.current to the panel's own
		// open item, matched by the bare artifact id (never the workspace item
		// id "artifact:" + id — see `activeArtifactId`'s own prop doc).
		it("outlines the card and reads 'Open in panel' when activeArtifactId matches this card's own artifact", () => {
			const { getByTestId } = render(ToolActivityRow, {
				item: buildToolActivityItem(artifactSegment(), "row-current", get(t)),
				activeArtifactId: "artifact-1",
			});

			const head = getByTestId("artifact-card-head");
			expect(head).toHaveTextContent("Open in panel");
		});

		it("reads plain 'Open' when activeArtifactId names a DIFFERENT artifact", () => {
			const { getByTestId } = render(ToolActivityRow, {
				item: buildToolActivityItem(
					artifactSegment(),
					"row-not-current",
					get(t),
				),
				activeArtifactId: "some-other-artifact",
			});

			const head = getByTestId("artifact-card-head");
			expect(head).not.toHaveTextContent("Open in panel");
			expect(head).toHaveTextContent("Open");
		});

		// Wave 2.5 Step 13: the App's fact-check line, read off `body.preview.
		// appVerification` — attached by `ThinkingBlock.svelte` from
		// `ConversationDetail.artifacts`, exactly like the Document card's own
		// `documentPreview` (this row only ever reads `item.body`, never
		// `conversationArtifacts` itself, so the test builds that same shape
		// directly rather than through a prop this component does not have).
		it("shows the App's fact-check line on the card once its facts were checked", () => {
			const segment = artifactSegment({
				name: "create_artifact",
				input: { artifactType: "app", title: "Trip budget splitter" },
				metadata: {
					ok: true,
					artifactId: "app-1",
					artifactKind: "app",
					artifactTitle: "Trip budget splitter",
				},
			});
			const built = buildToolActivityItem(segment, "row-factcheck", get(t));
			const withPreview: ToolActivityItem = {
				...built,
				body: {
					...(built.body as Extract<
						ToolActivityItem["body"],
						{ kind: "artifact" }
					>),
					preview: {
						id: "app-1",
						kind: "app",
						title: "Trip budget splitter",
						conversationId: "conv-1",
						versionNumber: 1,
						commentCount: 0,
						updatedAt: 0,
						appVerification: { checked: true, verdict: "repaired" },
					},
				},
			};
			const { getByTestId } = render(ToolActivityRow, { item: withPreview });

			const head = getByTestId("artifact-card-head");
			expect(head.parentElement).toHaveTextContent(
				"Alfy checked the facts and fixed one thing.",
			);
		});

		// Slice 3: a board's card says how many blocks it holds, from the count
		// the server put on `body.preview.canvasPreview` — the chat never loads the
		// board to say it.
		it("shows a board's block count on its card, from the server's preview", () => {
			const segment = artifactSegment({
				name: "create_artifact",
				input: { artifactType: "canvas", title: "Vienna trip board" },
				metadata: {
					ok: true,
					artifactId: "board-1",
					artifactKind: "canvas",
					artifactTitle: "Vienna trip board",
				},
			});
			const built = buildToolActivityItem(segment, "row-canvas", get(t));
			const withPreview: ToolActivityItem = {
				...built,
				body: {
					...(built.body as Extract<
						ToolActivityItem["body"],
						{ kind: "artifact" }
					>),
					preview: {
						id: "board-1",
						kind: "canvas",
						title: "Vienna trip board",
						conversationId: "conv-1",
						versionNumber: 7,
						commentCount: 0,
						updatedAt: 0,
						canvasPreview: { blockCount: 11 },
					},
				},
			};
			const { getByTestId } = render(ToolActivityRow, { item: withPreview });

			expect(getByTestId("artifact-card-head")).toHaveTextContent(
				"Canvas · 11 blocks",
			);
		});

		it("says just Canvas on a board's card until its count has arrived (a board made mid-turn)", () => {
			const built = buildToolActivityItem(
				artifactSegment({
					input: { artifactType: "canvas", title: "Vienna trip board" },
					metadata: {
						ok: true,
						artifactId: "board-1",
						artifactKind: "canvas",
						artifactTitle: "Vienna trip board",
					},
				}),
				"row-canvas-live",
				get(t),
			);
			const { getByTestId } = render(ToolActivityRow, { item: built });
			expect(getByTestId("artifact-card-head")).not.toHaveTextContent("block");
			expect(getByTestId("artifact-card-head")).toHaveTextContent("Canvas");
		});

		it("shows a skeleton standalone card while create_artifact is running, from the model's own call arguments", () => {
			const { getByTestId, queryByTestId } = render(ToolActivityRow, {
				item: buildToolActivityItem(
					toolCall({
						name: "create_artifact",
						input: { artifactType: "app", title: "Trip budget splitter" },
						status: "running",
					}),
					"row-creating",
					get(t),
				),
			});

			const card = getByTestId("tool-activity-standalone-card");
			expect(card).toHaveTextContent("Alfy is writing…");
			expect(queryByTestId("tool-activity-body")).not.toBeInTheDocument();
		});

		it("shows a failed standalone card with the reason for a refused create_artifact", () => {
			const { getByTestId, queryByTestId } = render(ToolActivityRow, {
				item: buildToolActivityItem(
					toolCall({
						name: "create_artifact",
						input: { artifactType: "app", title: "Trip budget splitter" },
						status: "done",
						outputSummary: "Could not create the app: the brief was empty.",
						metadata: { ok: false, artifactKind: "app" },
					}),
					"row-failed",
					get(t),
				),
			});

			const card = getByTestId("tool-activity-standalone-card");
			expect(card).toHaveTextContent(
				"Could not create the app: the brief was empty.",
			);
			expect(queryByTestId("tool-activity-body")).not.toBeInTheDocument();
		});

		it("a reload's persisted segment renders the exact same card — no live-only state involved", () => {
			// Nothing here distinguishes "live" from "after a reload": both cases
			// hand the SAME tool-call segment shape to buildToolActivityItem, so
			// a persisted segment (no different from a freshly-streamed one)
			// renders identically.
			const persisted = buildToolActivityItem(
				artifactSegment(),
				"row-reload",
				get(t),
			);
			const { getByTestId } = render(ToolActivityRow, {
				item: persisted,
			});
			expect(getByTestId("artifact-card")).toBeInTheDocument();
			expect(getByTestId("tool-activity-row")).toHaveTextContent(
				"Weekend plan",
			);
		});
	});
});
