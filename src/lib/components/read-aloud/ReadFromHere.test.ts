import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ReadAloudController,
	Readability,
} from "$lib/client/read-aloud/controller";
import { setReadAloudAvailable } from "$lib/stores/read-aloud";
import ReadFromHere from "./ReadFromHere.svelte";

const rect = (top: number, left = 40, height = 20, width = 120) =>
	({
		top,
		left,
		height,
		width,
		bottom: top + height,
		right: left + width,
		x: left,
		y: top,
		toJSON: () => ({}),
	}) as DOMRect;

function fakeController(
	readability: (ids: readonly string[]) => Readability,
): ReadAloudController {
	return {
		start: vi.fn(),
		toggle: vi.fn(),
		seek: vi.fn(),
		retry: vi.fn(),
		beginDrag: vi.fn(),
		dragTo: vi.fn(),
		endDrag: vi.fn(),
		setSpeed: vi.fn(),
		stop: vi.fn(),
		locate: vi.fn(),
		sentencePreview: vi.fn(() => ""),
		assessReadability: vi.fn(async (ids: readonly string[]) =>
			readability(ids),
		),
	};
}

const LONG_CODE = `<div class="code-block" data-language="ts"><pre class="shiki"><code>${[
	"a();",
	"b();",
	"c();",
	"d();",
	"e();",
]
	.map((line) => `<span class="line"><span>${line}</span></span>`)
	.join("\n")}</code></pre></div>`;

function mountThread() {
	document.body.innerHTML = `
		<div class="message-body" data-message-id="m1" data-read-aloud-segments="m1"><div class="prose-container"><div class="markdown-container"><p id="reply">The first sentence is here. The second one is here.</p></div></div></div>
		<div class="message-body" data-message-id="m2" data-read-aloud-segments="m2a m2"><div class="prose-container"><div class="markdown-container">${LONG_CODE}</div></div></div>
		<div class="outside"><p id="outside">Not a reply at all.</p></div>`;
}

function select(node: Node, start: number, end: number) {
	const range = document.createRange();
	range.setStart(node, start);
	range.setEnd(node, end);
	const selection = document.getSelection() as Selection;
	selection.removeAllRanges();
	selection.addRange(range);
	document.dispatchEvent(new Event("selectionchange"));
	return range;
}

function readFromHere(
	controller = fakeController((ids) =>
		ids.includes("m2") ? { kind: "nothing" } : { kind: "ready" },
	),
) {
	render(ReadFromHere, {
		props: { conversationId: "c1", composerHeight: 100, controller },
	});
	return controller;
}

const pill = () =>
	document.querySelector("button.read-from-here") as HTMLButtonElement | null;
let coarse = false;

beforeEach(() => {
	coarse = false;
	setReadAloudAvailable(true);
	mountThread();
	// jsdom lays nothing out: every selection's line is at y = 300.
	Object.defineProperty(Range.prototype, "getClientRects", {
		configurable: true,
		value: () => [rect(300)],
	});
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches: query.includes("coarse") ? coarse : false,
		media: query,
	}));
});

afterEach(() => {
	delete (Range.prototype as { getClientRects?: unknown }).getClientRects;
	vi.unstubAllGlobals();
	setReadAloudAvailable(false);
	document.getSelection()?.removeAllRanges();
	document.body.innerHTML = "";
});

describe("ReadFromHere", () => {
	it("shows the pill for a selection in a readable reply", async () => {
		readFromHere();
		const text = document.getElementById("reply")?.firstChild as Text;
		select(text, text.data.indexOf("second"), text.data.indexOf("second") + 6);
		await vi.waitFor(() => expect(pill()).toBeTruthy());
		expect(pill()?.textContent).toContain("Read from here");
		expect(pill()?.parentElement).toBe(document.body);
		// A collapsed selection takes it away.
		const selection = document.getSelection() as Selection;
		selection.collapseToStart();
		document.dispatchEvent(new Event("selectionchange"));
		await vi.waitFor(() => expect(pill()).toBeNull());
	});

	it("shows nothing for a selection outside replies", async () => {
		readFromHere();
		const text = document.getElementById("outside")?.firstChild as Text;
		select(text, 0, 3);
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(pill()).toBeNull();
	});

	it("shows nothing in a reply that cannot be read", async () => {
		readFromHere(fakeController(() => ({ kind: "noVoice", language: "de" })));
		const text = document.getElementById("reply")?.firstChild as Text;
		select(text, 0, 3);
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(pill()).toBeNull();
	});

	it("sits above on a fine pointer and below on a coarse one", async () => {
		readFromHere();
		const text = document.getElementById("reply")?.firstChild as Text;
		select(text, 4, 9);
		await vi.waitFor(() => expect(pill()).toBeTruthy());
		expect(pill()?.style.top).toBe("292px");
		coarse = true;
		select(text, 4, 10);
		await vi.waitFor(() => expect(pill()?.style.top).toBe("328px"));
	});

	it("starts reading at the selection's sentence", async () => {
		const controller = readFromHere();
		const text = document.getElementById("reply")?.firstChild as Text;
		const offset = text.data.indexOf("second");
		select(text, offset, offset + 6);
		await vi.waitFor(() => expect(pill()).toBeTruthy());
		await fireEvent.pointerDown(pill() as HTMLButtonElement);
		await fireEvent.click(pill() as HTMLButtonElement);
		expect(controller.start).toHaveBeenCalledWith({
			conversationId: "c1",
			messageId: "m1",
			segmentIds: ["m1"],
			from: { node: text, offset },
		});
		expect(document.getSelection()?.rangeCount).toBe(0);
		expect(pill()).toBeNull();
	});

	it("shows the pill inside a long code block, and starts there", async () => {
		const controller = readFromHere();
		const code = document.querySelector("pre span.line span")
			?.firstChild as Text;
		select(code, 0, 2);
		await vi.waitFor(() => expect(pill()).toBeTruthy());
		await fireEvent.click(
			screen.getByRole("button", { name: /Read from here/ }),
		);
		expect(controller.start).toHaveBeenCalledWith({
			conversationId: "c1",
			messageId: "m2",
			segmentIds: ["m2a", "m2"],
			from: { node: code, offset: 0 },
		});
	});
});
