import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	idleReadAloudView,
	type ReadAloudView,
	setReadAloudView,
} from "$lib/stores/read-aloud";
import ReadAloudMarks from "./ReadAloudMarks.svelte";

const rect = (left: number, top: number, width: number, height: number) =>
	({
		left,
		top,
		width,
		height,
		right: left + width,
		bottom: top + height,
		x: left,
		y: top,
		toJSON: () => ({}),
	}) as DOMRect;

/** Where each word sits on screen: "here." wraps to the second line. */
const LAYOUT: Record<string, DOMRect> = {
	The: rect(110, 210, 30, 20),
	first: rect(145, 210, 40, 20),
	sentence: rect(190, 210, 70, 20),
	"here.": rect(110, 235, 45, 20),
	Other: rect(110, 300, 50, 20),
};

function segment(text: string): { container: HTMLElement; ranges: Range[] } {
	const container = document.createElement("div");
	container.className = "prose-container";
	container.innerHTML = `<div class="markdown-container"><p>${text}</p></div>`;
	document.body.append(container);
	vi.spyOn(container, "getBoundingClientRect").mockReturnValue(
		rect(100, 200, 600, 400),
	);
	const node = container.querySelector("p")?.firstChild as Text;
	const ranges: Range[] = [];
	let offset = 0;
	for (const word of text.split(" ")) {
		const range = document.createRange();
		range.setStart(node, offset);
		range.setEnd(node, offset + word.length);
		ranges.push(range);
		offset += word.length + 1;
	}
	return { container, ranges };
}

const reading = (
	marks: ReadAloudView["marks"],
	extra: Partial<ReadAloudView> = {},
): ReadAloudView => ({
	...idleReadAloudView,
	status: "playing",
	key: "m1",
	segmentIds: ["m1"],
	count: 1,
	marks,
	...extra,
});

const boxStyle = (element: Element | null | undefined) => {
	const style = (element as HTMLElement | null)?.style;
	return {
		left: style?.left,
		top: style?.top,
		width: style?.width,
		height: style?.height,
	};
};

beforeEach(() => {
	// jsdom lays nothing out: a range's rects come from LAYOUT, by the word it holds.
	Object.defineProperty(Range.prototype, "getClientRects", {
		configurable: true,
		value(this: Range) {
			const found = LAYOUT[this.toString()];
			return found ? [found] : [];
		},
	});
	// Reduced motion: the fades are instant, so the end of the marks can be seen.
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches: query.includes("reduce"),
		media: query,
	}));
	setReadAloudView(idleReadAloudView);
});

afterEach(() => {
	delete (Range.prototype as { getClientRects?: unknown }).getClientRects;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	setReadAloudView(idleReadAloudView);
	document.body.innerHTML = "";
});

describe("ReadAloudMarks", () => {
	it("draws the sentence in boxes behind the text", async () => {
		const { container, ranges } = segment("The first sentence here.");
		const view = render(ReadAloudMarks, {
			props: { readingKey: "m1", container, onMarkedChange: vi.fn() },
		});
		setReadAloudView(reading({ sentence: ranges, word: null, target: [] }));
		await tick();
		const overlay = view.container.querySelector(
			".read-aloud-marks",
		) as HTMLElement;
		expect(overlay).toBeTruthy();
		expect(overlay.getAttribute("aria-hidden")).toBe("true");
		expect(overlay.style.zIndex).toBe("-1");
		expect(overlay.style.pointerEvents).toBe("none");
		expect(overlay.style.position).toBe("absolute");
		const boxes = [
			...overlay.querySelectorAll(".read-aloud-sentence .read-aloud-box"),
		];
		expect(boxes.map(boxStyle)).toEqual([
			{ left: "10px", top: "10px", width: "150px", height: "20px" },
			{ left: "10px", top: "35px", width: "45px", height: "20px" },
		]);
		expect(view.container.querySelector(".read-aloud-word")).toBeNull();
	});

	it("the word marker jumps without sliding to a new line", async () => {
		const { container, ranges } = segment("The first sentence here.");
		const [, first, sentence, here] = ranges as [Range, Range, Range, Range];
		const view = render(ReadAloudMarks, {
			props: { readingKey: "m1", container, onMarkedChange: vi.fn() },
		});
		setReadAloudView(reading({ sentence: ranges, word: first, target: [] }));
		await tick();
		const marker = () =>
			view.container.querySelector(".read-aloud-word") as HTMLElement;
		expect(marker().style.transform).toBe("translate(45px, 10px)");
		expect(marker().style.width).toBe("40px");
		setReadAloudView(reading({ sentence: ranges, word: sentence, target: [] }));
		await tick();
		expect(marker().style.transform).toBe("translate(90px, 10px)");
		expect(marker().classList.contains("jump")).toBe(false);
		setReadAloudView(reading({ sentence: ranges, word: here, target: [] }));
		await tick();
		expect(marker().style.transform).toBe("translate(10px, 35px)");
		expect(marker().classList.contains("jump")).toBe(true);
	});

	it("hides the word in a stopped reading, and shows the drag target instead of the reading", async () => {
		const { container, ranges } = segment("The first sentence here.");
		const view = render(ReadAloudMarks, {
			props: { readingKey: "m1", container, onMarkedChange: vi.fn() },
		});
		setReadAloudView(
			reading(
				{ sentence: ranges, word: ranges[1] ?? null, target: [] },
				{ status: "stopped" },
			),
		);
		await tick();
		expect(
			view.container.querySelectorAll(".read-aloud-sentence .read-aloud-box"),
		).toHaveLength(2);
		expect(view.container.querySelector(".read-aloud-word")).toBeNull();
		setReadAloudView(
			reading(
				{ sentence: ranges, word: ranges[1] ?? null, target: ranges.slice(3) },
				{ drag: 0 },
			),
		);
		await tick();
		expect(view.container.querySelector(".read-aloud-sentence")).toBeNull();
		expect(view.container.querySelector(".read-aloud-word")).toBeNull();
		expect(
			[...view.container.querySelectorAll(".read-aloud-target")].map(boxStyle),
		).toEqual([{ left: "10px", top: "35px", width: "45px", height: "20px" }]);
	});

	it("draws only the ranges inside its own segment", async () => {
		const a = segment("The first sentence here.");
		const b = segment("Other");
		const onA = vi.fn();
		const onB = vi.fn();
		const first = render(ReadAloudMarks, {
			props: { readingKey: "m1", container: a.container, onMarkedChange: onA },
		});
		const second = render(ReadAloudMarks, {
			props: { readingKey: "m1", container: b.container, onMarkedChange: onB },
		});
		setReadAloudView(reading({ sentence: a.ranges, word: null, target: [] }));
		await tick();
		expect(first.container.querySelectorAll(".read-aloud-box")).toHaveLength(2);
		expect(second.container.querySelector(".read-aloud-marks")).toBeNull();
		expect(onA).toHaveBeenLastCalledWith(true);
		expect(onB).not.toHaveBeenCalledWith(true);
		// Another reply's reading marks nothing here.
		setReadAloudView(
			reading({ sentence: a.ranges, word: null, target: [] }, { key: "m9" }),
		);
		await tick();
		expect(first.container.querySelector(".read-aloud-marks")).toBeNull();
	});

	it("measures its boxes again only when what is marked changes, never as the progress moves (early review R22)", async () => {
		// Without word times the view changes every frame (its progress does); each
		// measure is a forced layout, so a frame that marks the same ranges asks for none.
		let measured = 0;
		Object.defineProperty(Range.prototype, "getClientRects", {
			configurable: true,
			value(this: Range) {
				measured += 1;
				const found = LAYOUT[this.toString()];
				return found ? [found] : [];
			},
		});
		const { container, ranges } = segment("The first sentence here.");
		render(ReadAloudMarks, {
			props: { readingKey: "m1", container, onMarkedChange: vi.fn() },
		});
		const marks = { sentence: ranges, word: null, target: [] };
		setReadAloudView(reading(marks, { progress: 0.1 }));
		await tick();
		const first = measured;
		expect(first).toBeGreaterThan(0);
		for (const progress of [0.2, 0.3, 0.4]) {
			setReadAloudView(reading(marks, { progress }));
			await tick();
		}
		expect(measured).toBe(first);

		// A word to mark, a drag and a new sentence each measure again.
		setReadAloudView(
			reading({ ...marks, word: ranges[1] ?? null }, { progress: 0.5 }),
		);
		await tick();
		expect(measured).toBeGreaterThan(first);
	});

	it("isolates the prose only while it is marked", async () => {
		const { container, ranges } = segment("The first sentence here.");
		const onMarkedChange = vi.fn();
		render(ReadAloudMarks, {
			props: { readingKey: "m1", container, onMarkedChange },
		});
		await tick();
		expect(onMarkedChange).not.toHaveBeenCalled();
		setReadAloudView(reading({ sentence: ranges, word: null, target: [] }));
		await tick();
		expect(onMarkedChange).toHaveBeenLastCalledWith(true);
		setReadAloudView(idleReadAloudView);
		await tick();
		await tick();
		expect(onMarkedChange).toHaveBeenLastCalledWith(false);
	});
});
