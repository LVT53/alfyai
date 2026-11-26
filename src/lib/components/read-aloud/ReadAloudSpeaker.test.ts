// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	DocumentReadingSource,
	ReadAloudController,
	Readability,
	ReadingTarget,
} from "$lib/client/read-aloud/controller";
import {
	idleReadAloudView,
	type ReadAloudView,
	setReadAloudView,
} from "$lib/stores/read-aloud";
import { uiLanguage } from "$lib/stores/settings";
import ReadAloudSpeaker from "./ReadAloudSpeaker.svelte";

/** An IntersectionObserver that sees its target at once. */
class SeenAtOnce {
	constructor(private readonly callback: IntersectionObserverCallback) {}
	observe(target: Element) {
		this.callback(
			[
				{
					isIntersecting: true,
					target,
				} as unknown as IntersectionObserverEntry,
			],
			this as never,
		);
	}
	unobserve() {}
	disconnect() {}
	takeRecords() {
		return [];
	}
}

function fakeController(
	readability: Readability = { kind: "ready" },
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
		assessReadability: vi.fn(async () => readability),
	};
}

function view(extra: Partial<ReadAloudView>): ReadAloudView {
	return {
		...idleReadAloudView,
		key: "m1",
		segmentIds: ["m1"],
		count: 3,
		...extra,
	};
}

const REPLY: ReadingTarget = {
	kind: "reply",
	conversationId: "c1",
	messageId: "m1",
	segmentIds: ["m1"],
};

const SOURCE: DocumentReadingSource = {
	root: () => null,
	version: () => 3,
	revision: () => 0,
	settle: async () => {},
	focus: () => {},
};

const DOCUMENT: ReadingTarget = {
	kind: "document",
	artifactId: "doc-1",
	conversationId: "c1",
	source: SOURCE,
};

function speaker(
	controller = fakeController(),
	onPinnedChange = vi.fn(),
	extra: Record<string, unknown> = {},
) {
	const result = render(ReadAloudSpeaker, {
		props: {
			target: REPLY,
			contentKey: "Hello there.",
			onPinnedChange,
			controller,
			...extra,
		},
	});
	const button = () =>
		result.container.querySelector(
			"button.read-aloud-speaker",
		) as HTMLButtonElement;
	return { ...result, button, controller, onPinnedChange };
}

const setupObserver = globalThis.IntersectionObserver;

beforeEach(() => {
	// The setup file's observer never reports; this one sees the speaker at once.
	globalThis.IntersectionObserver =
		SeenAtOnce as unknown as typeof IntersectionObserver;
	uiLanguage.set("en");
	setReadAloudView(idleReadAloudView);
});

afterEach(() => {
	globalThis.IntersectionObserver = setupObserver;
	vi.useRealTimers();
	vi.unstubAllGlobals();
	setReadAloudView(idleReadAloudView);
	uiLanguage.set("en");
});

describe("ReadAloudSpeaker", () => {
	it("starts reading on press and shows the spinner", async () => {
		const t = speaker();
		expect(t.button().getAttribute("aria-label")).toBe("Read aloud");
		expect(t.button().querySelector(".lucide-volume-2")).toBeTruthy();
		await fireEvent.click(t.button());
		expect(t.controller.start).toHaveBeenCalledWith(REPLY);
		setReadAloudView(view({ status: "opening" }));
		await tick();
		expect(t.button().querySelector(".mini-spinner")).toBeTruthy();
		expect(t.onPinnedChange).toHaveBeenLastCalledWith(true);
	});

	it("shows the ring and pause while reading, and play while paused", async () => {
		const t = speaker();
		setReadAloudView(view({ status: "playing", progress: 0.25 }));
		await tick();
		expect(t.button().getAttribute("aria-label")).toBe("Pause reading");
		expect(t.button().querySelector(".lucide-pause")).toBeTruthy();
		const progress = t
			.button()
			.querySelector("circle.read-aloud-ring-progress");
		expect(progress?.getAttribute("r")).toBe("11.5");
		expect(progress?.getAttribute("stroke-dasharray")).toBe("72.26");
		expect(Number(progress?.getAttribute("stroke-dashoffset"))).toBeCloseTo(
			72.26 * 0.75,
		);
		for (const status of ["paused", "waiting", "stopped"] as const) {
			setReadAloudView(view({ status, progress: 0.5 }));
			await tick();
			expect(t.button().getAttribute("aria-label")).toBe("Resume reading");
			expect(t.button().querySelector(".lucide-play")).toBeTruthy();
		}
		// Another reply's reading leaves this speaker as it is.
		setReadAloudView(view({ status: "playing", key: "m2" }));
		await tick();
		expect(t.button().getAttribute("aria-label")).toBe("Read aloud");
		expect(
			t.button().querySelector("circle.read-aloud-ring-progress"),
		).toBeNull();
	});

	it("spins while it gets the voice for a switch or a jump, and never says Resume", async () => {
		const t = speaker();
		const ring = () =>
			t.button().querySelector("circle.read-aloud-ring-progress");
		// A switch from another reply: this one has not played, so it spins with no ring.
		setReadAloudView(view({ status: "seeking", progress: 0 }));
		await tick();
		expect(t.button().querySelector(".mini-spinner")).toBeTruthy();
		expect(t.button().querySelector(".lucide-play")).toBeNull();
		expect(t.button().getAttribute("aria-label")).toBe("Read aloud");
		expect(t.button().getAttribute("aria-busy")).toBe("true");
		expect(ring()).toBeNull();
		// Its first audio: the ring appears.
		setReadAloudView(view({ status: "playing", progress: 0.2 }));
		await tick();
		expect(ring()).toBeTruthy();
		expect(t.button().getAttribute("aria-busy")).toBeNull();
		// A jump inside the reading spins too, and keeps the ring.
		setReadAloudView(view({ status: "seeking", progress: 0.6 }));
		await tick();
		expect(t.button().querySelector(".mini-spinner")).toBeTruthy();
		expect(t.button().getAttribute("aria-label")).toBe("Read aloud");
		expect(ring()).toBeTruthy();
		// The reading ends: the next switch to this reply spins without a ring again.
		setReadAloudView(idleReadAloudView);
		await tick();
		setReadAloudView(view({ status: "seeking", progress: 0 }));
		await tick();
		expect(ring()).toBeNull();
	});

	it("the end fills the ring and shows the speaker again", async () => {
		const t = speaker();
		setReadAloudView(view({ status: "playing", progress: 0.9 }));
		await tick();
		setReadAloudView(view({ status: "finished", progress: 1 }));
		await tick();
		const progress = t
			.button()
			.querySelector("circle.read-aloud-ring-progress");
		expect(Number(progress?.getAttribute("stroke-dashoffset"))).toBe(0);
		expect(t.button().querySelector(".lucide-volume-2")).toBeTruthy();
		expect(t.button().getAttribute("aria-label")).toBe("Read aloud");
		// Its room closes after "Finished": the ring goes with it.
		setReadAloudView(idleReadAloudView);
		await tick();
		expect(
			t.button().querySelector("circle.read-aloud-ring-progress"),
		).toBeNull();
	});

	it("has a tooltip with its label, as its neighbours do, unless a note shows", async () => {
		const t = speaker();
		const tooltip = () =>
			t.container.querySelector(".read-aloud-speaker-tooltip");
		expect(tooltip()?.textContent?.trim()).toBe("Read aloud");
		// The button's name says it already: the tooltip is for the eye.
		expect(tooltip()?.getAttribute("aria-hidden")).toBe("true");
		setReadAloudView(view({ status: "playing" }));
		await tick();
		expect(tooltip()?.textContent?.trim()).toBe("Pause reading");
		setReadAloudView(view({ status: "opening", busy: true }));
		await tick();
		expect(screen.getByRole("status").textContent).toContain("busy");
		expect(tooltip()).toBeNull();
	});

	it("dims with a note naming the language", async () => {
		const t = speaker(fakeController({ kind: "noVoice", language: "de" }));
		await vi.waitFor(() =>
			expect(t.button().getAttribute("aria-disabled")).toBe("true"),
		);
		expect(screen.queryByRole("status")).toBeNull();
		await fireEvent.pointerEnter(t.button());
		expect(screen.getByRole("status").textContent).toContain(
			"Read aloud isn't available in German yet.",
		);
		await fireEvent.click(t.button());
		expect(t.controller.start).not.toHaveBeenCalled();
		await fireEvent.pointerLeave(t.button());
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("the Hungarian note names the language", async () => {
		uiLanguage.set("hu");
		const t = speaker(fakeController({ kind: "noVoice", language: "de" }));
		await vi.waitFor(() =>
			expect(t.button().getAttribute("aria-disabled")).toBe("true"),
		);
		await fireEvent.focus(t.button());
		expect(screen.getByRole("status").textContent).toContain(
			"Német nyelvű felolvasás még nem érhető el.",
		);
	});

	it("dims a reply with nothing to read", async () => {
		const t = speaker(fakeController({ kind: "nothing" }));
		await vi.waitFor(() =>
			expect(t.button().getAttribute("aria-disabled")).toBe("true"),
		);
		await fireEvent.focus(t.button());
		expect(screen.getByRole("status").textContent).toContain(
			"Nothing in this reply can be read aloud.",
		);
	});

	it("asks again while the reply has not rendered yet", async () => {
		const controller = fakeController();
		let calls = 0;
		controller.assessReadability = vi.fn(async (): Promise<Readability> => {
			calls += 1;
			return calls < 3
				? { kind: "unknown" }
				: { kind: "noVoice", language: "de" };
		});
		const t = speaker(controller);
		await vi.waitFor(
			() => expect(t.button().getAttribute("aria-disabled")).toBe("true"),
			{ timeout: 3000 },
		);
		expect(controller.assessReadability).toHaveBeenCalledTimes(3);
	});

	it("asks again when the reply's words change", async () => {
		const controller = fakeController();
		const t = speaker(controller);
		await vi.waitFor(() =>
			expect(controller.assessReadability).toHaveBeenCalledTimes(1),
		);
		await t.rerender({
			target: REPLY,
			contentKey: "New words.",
			onPinnedChange: vi.fn(),
			controller,
		});
		await vi.waitFor(() =>
			expect(controller.assessReadability).toHaveBeenCalledTimes(2),
		);
	});

	it("shows the busy note", async () => {
		speaker();
		setReadAloudView(view({ status: "opening", busy: true }));
		await tick();
		expect(screen.getByRole("status").textContent).toContain(
			"The voice is busy with another reading. Yours starts in a moment.",
		);
		setReadAloudView(view({ status: "playing" }));
		await tick();
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("shows the can't-start note with Try again, which closes after 8 s", async () => {
		vi.useFakeTimers();
		const t = speaker();
		setReadAloudView(view({ status: "startFailed" }));
		await tick();
		expect(t.button().querySelector(".lucide-volume-x")).toBeTruthy();
		const note = screen.getByRole("status");
		expect(note.textContent).toContain(
			"Couldn't start reading. The voice isn't answering right now.",
		);
		// The speaker settles after 3 s; the note stays until 8 s.
		vi.advanceTimersByTime(3000);
		setReadAloudView(idleReadAloudView);
		await tick();
		expect(t.button().querySelector(".lucide-volume-2")).toBeTruthy();
		expect(screen.queryByRole("status")).toBeTruthy();
		vi.advanceTimersByTime(5000);
		await tick();
		expect(screen.queryByRole("status")).toBeNull();
		// Try again starts the reading again and closes the note; ✕ closes it too.
		setReadAloudView(view({ status: "startFailed" }));
		await tick();
		await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(t.controller.start).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("status")).toBeNull();
		setReadAloudView(idleReadAloudView);
		await tick();
		setReadAloudView(view({ status: "startFailed" }));
		await tick();
		await fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("closes the can't-start note on a click elsewhere", async () => {
		speaker();
		setReadAloudView(view({ status: "startFailed" }));
		await tick();
		expect(screen.getByRole("status")).toBeTruthy();
		await fireEvent.pointerDown(document.body);
		expect(screen.queryByRole("status")).toBeNull();
	});
});

describe("ReadAloudSpeaker in a Document's header", () => {
	const header = (controller = fakeController()) =>
		speaker(controller, vi.fn(), {
			target: DOCUMENT,
			contentKey: 1,
			placement: "header",
		});

	it("starts the Document's reading and follows it by the Document's key", async () => {
		const t = header();
		expect(t.button().getAttribute("aria-label")).toBe("Read aloud");
		await fireEvent.click(t.button());
		expect(t.controller.start).toHaveBeenCalledWith(DOCUMENT);
		setReadAloudView(
			view({ status: "playing", key: "document:doc-1", progress: 0.5 }),
		);
		await tick();
		expect(t.button().getAttribute("aria-label")).toBe("Pause reading");
		expect(
			t.button().querySelector("circle.read-aloud-ring-progress"),
		).toBeTruthy();
		// A reply's reading is not this Document's.
		setReadAloudView(view({ status: "playing", key: "m1" }));
		await tick();
		expect(t.button().getAttribute("aria-label")).toBe("Read aloud");
	});

	it("says a Document with nothing to read is a document, with its note below it", async () => {
		const t = header(fakeController({ kind: "nothing" }));
		await vi.waitFor(() =>
			expect(t.button().getAttribute("aria-disabled")).toBe("true"),
		);
		await fireEvent.focus(t.button());
		const note = screen.getByRole("status");
		expect(note.textContent).toContain(
			"Nothing in this document can be read aloud.",
		);
		expect(note.getAttribute("data-placement")).toBe("header");
	});

	it("names itself with a title, as the header's other buttons do, and draws no row tooltip", () => {
		const t = header();
		expect(t.button().getAttribute("title")).toBe("Read aloud");
		expect(t.container.querySelector(".read-aloud-speaker-tooltip")).toBeNull();
		expect(t.button().getAttribute("data-testid")).toBe(
			"read-aloud-speaker-header",
		);
	});
});
