import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ReadAloudController,
	Readability,
} from "$lib/client/read-aloud/controller";
import { setReadAloudAvailable } from "$lib/stores/read-aloud";
import { uiLanguage } from "$lib/stores/settings";
import ReadFromHere from "./ReadFromHere.svelte";

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

/** The selection spans two lines: where it starts, and where it ends. */
const FIRST_LINE = rect(100, 300, 60, 20);
const LAST_LINE = rect(40, 330, 80, 20);
const PILL = { width: 150, height: 40 };

let coarse = false;
let rects: DOMRect[] = [FIRST_LINE, LAST_LINE];
let controller: {
	start: ReturnType<typeof vi.fn>;
	assessReadability: ReturnType<typeof vi.fn>;
};

function setReadability(result: Readability) {
	controller.assessReadability.mockResolvedValue(result);
}

/** A reply as `MessageBubble` draws it: its body names the segments of the reply. */
function reply(html: string, segments = "m1 m2") {
	const body = document.createElement("div");
	body.className = "message-body";
	body.setAttribute("data-read-aloud-segments", segments);
	body.innerHTML = `<div class="markdown-container">${html}</div>`;
	document.body.append(body);
	return body;
}

function select(start: Node, from: number, to: number, end: Node = start) {
	const range = document.createRange();
	range.setStart(start, from);
	range.setEnd(end, to);
	const selection = document.getSelection() as Selection;
	selection.removeAllRanges();
	selection.addRange(range);
	document.dispatchEvent(new Event("selectionchange"));
	return range;
}

function collapse() {
	(document.getSelection() as Selection).removeAllRanges();
	document.dispatchEvent(new Event("selectionchange"));
}

function renderPill(
	props: { conversationId?: string | null; composerHeight?: number } = {},
) {
	return render(ReadFromHere, {
		conversationId: "conv-1",
		composerHeight: 100,
		controller: controller as unknown as ReadAloudController,
		...props,
	});
}

const pill = () => screen.getByTestId("read-from-here");

beforeEach(() => {
	coarse = false;
	rects = [FIRST_LINE, LAST_LINE];
	controller = {
		start: vi.fn(),
		assessReadability: vi.fn().mockResolvedValue({ kind: "ready" }),
	};
	setReadAloudAvailable(true);
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		callback(0);
		return 1;
	});
	vi.stubGlobal("cancelAnimationFrame", () => undefined);
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches: query.includes("coarse") ? coarse : false,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
	}));
	Object.defineProperty(Range.prototype, "getClientRects", {
		configurable: true,
		value: () => rects,
	});
	vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(
		PILL.width,
	);
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(
		PILL.height,
	);
});

afterEach(() => {
	document.body.innerHTML = "";
	document.getSelection()?.removeAllRanges();
	setReadAloudAvailable(false);
	uiLanguage.set("en");
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	Reflect.deleteProperty(Range.prototype, "getClientRects");
});

describe("ReadFromHere", () => {
	it("shows the pill for a selection in a readable reply", async () => {
		const body = reply("<p>First sentence here. Second sentence there.</p>");
		renderPill();
		expect(screen.queryByTestId("read-from-here")).toBeNull();
		select(body.querySelector("p")?.firstChild as Text, 6, 14);
		await waitFor(() => expect(pill()).toBeTruthy());
		expect(pill().textContent?.trim()).toBe("Read from here");
		expect(controller.assessReadability).toHaveBeenCalledWith(["m1", "m2"]);
		// The pill is moved to the body, so `position: fixed` means the viewport.
		expect(pill().parentElement).toBe(document.body);
	});

	it("says it in Hungarian", async () => {
		uiLanguage.set("hu");
		const body = reply("<p>Első mondat itt. Második mondat ott.</p>");
		renderPill();
		select(body.querySelector("p")?.firstChild as Text, 0, 5);
		await waitFor(() =>
			expect(pill().textContent?.trim()).toBe("Felolvasás innen"),
		);
	});

	it("shows nothing for a selection outside replies, a collapsed one, or when read aloud is off", async () => {
		const outside = document.createElement("p");
		outside.textContent = "Not in any reply at all.";
		document.body.append(outside);
		const body = reply("<p>First sentence here. Second sentence there.</p>");
		renderPill();

		select(outside.firstChild as Text, 0, 10);
		await Promise.resolve();
		expect(screen.queryByTestId("read-from-here")).toBeNull();
		expect(controller.assessReadability).not.toHaveBeenCalled();

		select(body.querySelector("p")?.firstChild as Text, 4, 4);
		await Promise.resolve();
		expect(screen.queryByTestId("read-from-here")).toBeNull();

		setReadAloudAvailable(false);
		select(body.querySelector("p")?.firstChild as Text, 0, 5);
		await Promise.resolve();
		expect(screen.queryByTestId("read-from-here")).toBeNull();
	});

	it("shows nothing for a reply that cannot be read, or with no chat", async () => {
		const body = reply(
			"<p>Dieser Satz ist deutsch genug für den Test hier.</p>",
		);
		renderPill();
		setReadability({ kind: "noVoice", language: "de" });
		select(body.querySelector("p")?.firstChild as Text, 0, 5);
		await waitFor(() =>
			expect(controller.assessReadability).toHaveBeenCalled(),
		);
		expect(screen.queryByTestId("read-from-here")).toBeNull();
		// Prose of a reply with nothing to read gets no pill either: only its code does.
		setReadability({ kind: "nothing" });
		select(body.querySelector("p")?.firstChild as Text, 1, 6);
		await waitFor(() =>
			expect(controller.assessReadability).toHaveBeenCalledTimes(2),
		);
		expect(screen.queryByTestId("read-from-here")).toBeNull();
	});

	it("renders nothing without a conversation", async () => {
		const body = reply("<p>First sentence here. Second sentence there.</p>");
		renderPill({ conversationId: null });
		select(body.querySelector("p")?.firstChild as Text, 0, 5);
		await Promise.resolve();
		expect(screen.queryByTestId("read-from-here")).toBeNull();
	});

	it("sits above on a fine pointer and below on a coarse one", async () => {
		const body = reply("<p>First sentence here. Second sentence there.</p>");
		renderPill();
		const text = body.querySelector("p")?.firstChild as Text;

		select(text, 6, 14);
		await waitFor(() => expect(pill()).toBeTruthy());
		// 8 px above the selection's first line, centred on it: 300 - 8 - 40, and 100 + 30 - 75.
		expect(pill().style.top).toBe("252px");
		expect(pill().style.left).toBe("55px");

		collapse();
		await waitFor(() =>
			expect(screen.queryByTestId("read-from-here")).toBeNull(),
		);
		coarse = true;
		select(text, 6, 14);
		await waitFor(() => expect(pill()).toBeTruthy());
		// 8 px below its last line: 350 + 8.
		expect(pill().style.top).toBe("358px");
	});

	it("keeps the pill inside the viewport and above the composer", async () => {
		const body = reply("<p>First sentence here. Second sentence there.</p>");
		renderPill({ composerHeight: 120 });
		const text = body.querySelector("p")?.firstChild as Text;
		// Near the bottom and the right edge, and at the top-left corner.
		rects = [rect(990, 700, 30, 20), rect(990, 700, 30, 20)];
		select(text, 0, 5);
		await waitFor(() => expect(pill()).toBeTruthy());
		// Left: at most 1024 - 16 - 150; top: its bottom edge at most at 768 - 120.
		expect(pill().style.left).toBe("858px");
		expect(pill().style.top).toBe("608px");
		collapse();
		await waitFor(() =>
			expect(screen.queryByTestId("read-from-here")).toBeNull(),
		);
		rects = [rect(2, 4, 10, 10), rect(2, 4, 10, 10)];
		select(text, 0, 5);
		await waitFor(() => expect(pill()).toBeTruthy());
		expect(pill().style.left).toBe("16px");
		expect(pill().style.top).toBe("16px");
	});

	it("starts reading at the selection's sentence, and clears the selection", async () => {
		const body = reply("<p>First sentence here. Second sentence there.</p>");
		renderPill();
		const text = body.querySelector("p")?.firstChild as Text;
		select(text, 25, 31);
		await waitFor(() => expect(pill()).toBeTruthy());
		await fireEvent.click(pill());
		expect(controller.start).toHaveBeenCalledTimes(1);
		expect(controller.start).toHaveBeenCalledWith({
			conversationId: "conv-1",
			messageId: "m2",
			segmentIds: ["m1", "m2"],
			from: { node: text, offset: 25 },
		});
		expect((document.getSelection() as Selection).rangeCount).toBe(0);
		expect(screen.queryByTestId("read-from-here")).toBeNull();
	});

	it("keeps the last selection that was not collapsed when the press collapses it", async () => {
		const body = reply("<p>First sentence here. Second sentence there.</p>");
		renderPill();
		const text = body.querySelector("p")?.firstChild as Text;
		select(text, 6, 14);
		await waitFor(() => expect(pill()).toBeTruthy());
		// A press on a phone can collapse the selection before the click arrives.
		await fireEvent.pointerDown(pill());
		collapse();
		await Promise.resolve();
		expect(pill()).toBeTruthy();
		await fireEvent.click(pill());
		expect(controller.start).toHaveBeenCalledWith(
			expect.objectContaining({ from: { node: text, offset: 6 } }),
		);
	});

	it("hides when the selection collapses elsewhere", async () => {
		const body = reply("<p>First sentence here. Second sentence there.</p>");
		renderPill();
		select(body.querySelector("p")?.firstChild as Text, 6, 14);
		await waitFor(() => expect(pill()).toBeTruthy());
		collapse();
		await waitFor(() =>
			expect(screen.queryByTestId("read-from-here")).toBeNull(),
		);
	});

	it("shows the pill inside a long code block, and starts there", async () => {
		const body = reply(
			`<div class="code-block" data-language="js"><pre><code><span class="line">const secretCode = 42;</span>\n<span class="line">const other = 1;</span></code></pre></div>`,
		);
		renderPill();
		setReadability({ kind: "nothing" });
		const line = body.querySelector(".line")?.firstChild as Text;
		select(line, 6, 16);
		await waitFor(() => expect(pill()).toBeTruthy());
		await fireEvent.click(pill());
		expect(controller.start).toHaveBeenCalledWith({
			conversationId: "conv-1",
			messageId: "m2",
			segmentIds: ["m1", "m2"],
			from: { node: line, offset: 6 },
		});
	});

	it("reads a single-row reply's own id", async () => {
		const body = reply("<p>One row only, in this reply.</p>", "solo");
		renderPill();
		select(body.querySelector("p")?.firstChild as Text, 0, 3);
		await waitFor(() => expect(pill()).toBeTruthy());
		await fireEvent.click(pill());
		expect(controller.start).toHaveBeenCalledWith(
			expect.objectContaining({ messageId: "solo", segmentIds: ["solo"] }),
		);
	});
});
