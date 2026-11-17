import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ReadAloudController,
	ReportReadingSource,
} from "$lib/client/read-aloud/controller";
import { REPORT_BRIDGE_KIND } from "$lib/shared/read-aloud/report-bridge";
import {
	idleReadAloudView,
	setReadAloudAvailable,
	setReadAloudView,
} from "$lib/stores/read-aloud";
import ReportReadAloud from "./ReportReadAloud.svelte";

/** Three blocks, 74 characters: what the bridge in the frame says it found when it agrees. */
const REPORT = `<!doctype html><html><head></head><body><aside class="report-sidebar"><p>Sections</p></aside><article class="report-content" id="report-content"><h1 class="report-title">Weekend report</h1><section class="report-section"><h2>Getting there</h2><p>The train leaves at nine<button type="button" class="basis-marker"><span class="basis-tooltip" role="tooltip">Supported claim</span></button> from the main station.</p></section></article></body></html>`;

function fakeController(): ReadAloudController {
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
		assessReadability: vi.fn(async () => ({ kind: "ready" as const })),
	};
}

let frame: HTMLIFrameElement;
let other: HTMLIFrameElement;
let posted: unknown[];
let controller: ReadAloudController;
let source: ReportReadingSource | null;
const onSource = vi.fn(
	(
		next: {
			report: { fileId: string } | { artifactId: string };
			source: ReportReadingSource;
		} | null,
	) => {
		source = next?.source ?? null;
	},
);

const message = (type: string, extra: Record<string, unknown> = {}) => ({
	v: 1,
	kind: REPORT_BRIDGE_KIND,
	type,
	...extra,
});

/** What the frame says, as the page hears it: from the frame's window, opaque origin. */
async function frameSays(
	data: unknown,
	from: Window | null = frame.contentWindow,
	origin = "null",
) {
	window.dispatchEvent(
		new MessageEvent("message", { data, source: from, origin }),
	);
	await tick();
}

const ready = () => frameSays(message("ready", { blocks: 3, chars: 74 }));
const selection = (block = 2, offset = 4) =>
	frameSays(
		message("selection", {
			block,
			offset,
			x: 40,
			y: 120,
			width: 90,
			height: 18,
		}),
	);
const pill = () => screen.queryByRole("button", { name: "Read from here" });

function mount() {
	const shell = document.createElement("div");
	shell.className = "html-preview-shell";
	frame = document.createElement("iframe");
	other = document.createElement("iframe");
	shell.append(frame);
	document.body.append(shell, other);
	posted = [];
	vi.spyOn(frame.contentWindow as Window, "postMessage").mockImplementation(((
		data: unknown,
	) => {
		posted.push(data);
	}) as typeof window.postMessage);
	return render(ReportReadAloud, {
		target: shell,
		props: {
			frame,
			html: REPORT,
			report: { fileId: "file-1" },
			onSource,
			controller,
		},
	});
}

beforeEach(() => {
	setReadAloudAvailable(true);
	setReadAloudView(idleReadAloudView);
	controller = fakeController();
	source = null;
	onSource.mockClear();
});

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = "";
	setReadAloudView(idleReadAloudView);
});

describe("read aloud on a report", () => {
	it("says hello to the frame, and hands the panel a source over the page's own inert copy, with the report it names", async () => {
		mount();
		await tick();
		expect(onSource).toHaveBeenCalledWith({
			report: { fileId: "file-1" },
			source: expect.any(Object),
		});
		expect(posted).toContainEqual(message("hello"));
		expect(source?.root()?.id).toBe("report-content");
		expect(source?.root()?.ownerDocument).not.toBe(document);
		expect(source?.root()?.textContent).not.toContain("Sections");
	});

	it("shows its own Read from here where the frame says the reader selected, and a press in the page reads from there", async () => {
		mount();
		await ready();
		await selection(2, 4);
		const button = pill();
		expect(button).not.toBeNull();
		expect(controller.start).not.toHaveBeenCalled();
		await fireEvent.pointerMove(button as HTMLElement);
		await fireEvent.click(button as HTMLElement, { detail: 1 });
		expect(controller.start).toHaveBeenCalledTimes(1);
		const request = vi.mocked(controller.start).mock.calls[0]?.[0];
		expect(request).toMatchObject({
			kind: "report",
			report: { fileId: "file-1" },
		});
		const from = request && "from" in request ? request.from : undefined;
		expect((from?.node as Text).data).toBe("The train leaves at nine");
		expect(from?.offset).toBe(4);
		expect(pill()).toBeNull();
	});

	it("never starts a reading from what the frame says: a selection only shows the control", async () => {
		mount();
		await ready();
		for (let i = 0; i < 5; i++) await selection(2, i);
		await frameSays(message("deselect"));
		expect(controller.start).not.toHaveBeenCalled();
		expect(controller.toggle).not.toHaveBeenCalled();
		expect(controller.seek).not.toHaveBeenCalled();
	});

	it("takes no press the pointer never came to: the control may have appeared under it", async () => {
		mount();
		await ready();
		await selection();
		// A mouse's click (detail 1) where the pointer never moved over the control.
		await fireEvent.click(pill() as HTMLElement, { detail: 1 });
		expect(controller.start).not.toHaveBeenCalled();
		// A keyboard's press (detail 0) is always deliberate.
		await fireEvent.click(pill() as HTMLElement, { detail: 0 });
		expect(controller.start).toHaveBeenCalledTimes(1);
	});

	it("ignores a message posted from another window", async () => {
		mount();
		await frameSays(message("ready", { blocks: 3, chars: 74 }), window, "null");
		await frameSays(
			message("ready", { blocks: 3, chars: 74 }),
			other.contentWindow,
			"null",
		);
		await selection();
		expect(pill()).toBeNull();
		await ready();
		await frameSays(
			message("selection", {
				block: 2,
				offset: 4,
				x: 0,
				y: 0,
				width: 9,
				height: 9,
			}),
			other.contentWindow,
		);
		expect(pill()).toBeNull();
	});

	it("takes no selection while the frame's units do not agree with the page's copy", async () => {
		mount();
		await frameSays(message("ready", { blocks: 4, chars: 80 }));
		await selection();
		expect(pill()).toBeNull();
	});

	it("hides the control when the reader deselects", async () => {
		mount();
		await ready();
		await selection();
		expect(pill()).not.toBeNull();
		await frameSays(message("deselect"));
		expect(pill()).toBeNull();
	});

	it("sends the frame the marks of this report's reading, and clear when it ends", async () => {
		mount();
		await ready();
		const text = source?.root()?.querySelector("p")?.firstChild as Text;
		const range = (from: number, to: number) => {
			const made = text.ownerDocument.createRange();
			made.setStart(text, from);
			made.setEnd(text, to);
			return made;
		};
		posted.length = 0;
		setReadAloudView({
			...idleReadAloudView,
			status: "playing",
			key: "report:file-1",
			target: "report",
			count: 1,
			marks: {
				sentence: [range(0, 3), range(4, 9)],
				word: range(4, 9),
				target: [],
			},
		});
		await tick();
		expect(posted).toEqual([
			message("marks", { sentence: [[2, 0, 9]], word: [2, 4, 9], target: [] }),
		]);
		setReadAloudView(idleReadAloudView);
		await tick();
		expect(posted.at(-1)).toEqual(message("clear"));
	});

	it("brings a sentence into view in the frame by its spans", async () => {
		mount();
		await ready();
		const text = source?.root()?.querySelector("p")?.firstChild as Text;
		const range = text.ownerDocument.createRange();
		range.setStart(text, 4);
		range.setEnd(text, 9);
		posted.length = 0;
		source?.focus([range], "center");
		expect(posted).toEqual([
			message("focus", { spans: [[2, 4, 9]], mode: "center" }),
		]);
	});

	it("hands the panel nothing once it is gone, and its source reads nothing", async () => {
		const view = mount();
		await tick();
		const handed = source;
		view.unmount();
		expect(onSource).toHaveBeenLastCalledWith(null);
		expect(handed?.root()).toBeNull();
	});
});
