import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactComment } from "$lib/server/services/artifacts/types";
import type { Anchor } from "$lib/shared/artifacts/anchor";
import type { CanvasNode } from "$lib/shared/artifacts/canvas";
import { uiLanguage } from "$lib/stores/settings";
import CommentPins from "./CommentPins.svelte";

// The pins drawn on their own, on a board whose screen and board coordinates are
// the same: what is drawn for a thread, what a press does, what a jump does. That
// a pin really paints above a frame's children is the e2e's
// (artifact-canvas-comments.spec.ts).

beforeEach(() => {
	uiLanguage.set("en");
});

afterEach(() => {
	document.body.innerHTML = "";
});

function thread(
	id: string,
	anchor: Anchor | null,
	status: "open" | "resolved" = "open",
): ArtifactComment {
	return {
		id,
		artifactId: "board-1",
		parentId: null,
		anchor,
		author: "user",
		body: `comment ${id}`,
		status,
		createdAt: 1,
		replies: [],
	};
}

function sticky(
	id: string,
	x: number,
	y: number,
	extra: Partial<CanvasNode> = {},
): CanvasNode {
	return {
		id,
		type: "sticky",
		position: { x, y },
		width: 200,
		height: 100,
		data: { kind: "sticky", text: `note ${id}`, tone: "yellow" },
		...extra,
	};
}

const FRAME: CanvasNode = {
	id: "frame-a",
	type: "frame",
	position: { x: 400, y: 300 },
	width: 400,
	height: 300,
	data: { kind: "frame", label: "Saturday", width: 400, height: 300 },
};
const NODES: CanvasNode[] = [sticky("note-1", 100, 100), FRAME];

function mount(
	props: Partial<{
		threads: ArtifactComment[];
		nodes: CanvasNode[];
		zoom: number;
		activeId: string | null;
		draft: Anchor | null;
		showResolved: boolean;
		goto: { commentId: string; token: number } | null;
	}> = {},
) {
	const callbacks = { oncenter: vi.fn(), onselect: vi.fn() };
	const { zoom = 1, ...rest } = props;
	const view = render(CommentPins, {
		threads: [],
		nodes: NODES,
		viewport: { x: 0, y: 0, zoom },
		...callbacks,
		...rest,
	});
	return { ...view, ...callbacks };
}

const pins = () => screen.queryAllByTestId("canvas-comment-pin");

describe("the pins", () => {
	it("draws one numbered pin per thread, on its block's top-right corner or at its point, in board space", () => {
		mount({
			threads: [
				thread("a", { kind: "node", nodeId: "note-1" }),
				thread("b", { kind: "point", x: 640, y: 20 }),
			],
		});
		const [onNode, onSpot] = pins();
		expect(onNode.textContent?.trim()).toBe("1");
		expect(onNode.style.left).toBe("300px");
		expect(onNode.style.top).toBe("100px");
		expect(onSpot.textContent?.trim()).toBe("2");
		expect(onSpot.style.left).toBe("640px");
		expect(onSpot.style.top).toBe("20px");
	});

	it("counter-scales every pin by the zoom, so it is the same size on screen at any zoom", () => {
		mount({
			threads: [thread("a", { kind: "point", x: 5, y: 5 })],
			zoom: 0.25,
		});
		expect(pins()[0].style.getPropertyValue("--pin-scale")).toBe("4");
	});

	it("names each pin as a button, with its number", () => {
		mount({ threads: [thread("a", { kind: "point", x: 5, y: 5 })] });
		expect(
			screen.getByRole("button", { name: "Comment 1 on the board" }),
		).toBeTruthy();
	});

	it("says in Hungarian what it says in English", () => {
		uiLanguage.set("hu");
		mount({ threads: [thread("a", { kind: "point", x: 5, y: 5 })] });
		expect(
			screen.getByRole("button", { name: "1. megjegyzés a táblán" }),
		).toBeTruthy();
	});

	it("keeps a resolved thread's number, and shows its pin only when the list is showing resolved threads", async () => {
		const threads = [
			thread("a", { kind: "point", x: 5, y: 5 }),
			thread("b", { kind: "point", x: 9, y: 9 }, "resolved"),
			thread("c", { kind: "point", x: 20, y: 20 }),
		];
		const { rerender } = mount({ threads });
		expect(pins().map((pin) => pin.textContent?.trim())).toEqual(["1", "3"]);
		await rerender({ threads, showResolved: true });
		const shown = pins();
		expect(shown.map((pin) => pin.textContent?.trim())).toEqual([
			"1",
			"2",
			"3",
		]);
		expect(shown[1].classList.contains("pin--resolved")).toBe(true);
		expect(shown[1].getAttribute("aria-label")).toBe(
			"Comment 2 on the board, resolved",
		);
	});

	it("draws no pin for a thread whose block is gone, and none for one that could not be read", () => {
		mount({
			threads: [
				thread("gone", { kind: "node", nodeId: "deleted" }),
				thread("unreadable", null),
				thread("here", { kind: "point", x: 1, y: 1 }),
			],
		});
		expect(pins()).toHaveLength(1);
		// It is the third thread: its number is its place in the list, not in the pins.
		expect(pins()[0].textContent?.trim()).toBe("3");
	});

	it("follows its block when the block moves", async () => {
		const threads = [thread("a", { kind: "node", nodeId: "note-1" })];
		const { rerender } = mount({ threads });
		await rerender({ threads, nodes: [sticky("note-1", 300, 500), FRAME] });
		expect(pins()[0].style.left).toBe("500px");
		expect(pins()[0].style.top).toBe("500px");
	});

	it("hands the thread's id over when its pin is pressed, and marks the one the list has selected", async () => {
		const { onselect } = mount({
			threads: [
				thread("a", { kind: "point", x: 5, y: 5 }),
				thread("b", { kind: "point", x: 9, y: 9 }),
			],
			activeId: "b",
		});
		const [first, second] = pins();
		expect(second.getAttribute("aria-current")).toBe("true");
		expect(first.getAttribute("aria-current")).toBeNull();
		await fireEvent.click(first);
		expect(onselect).toHaveBeenCalledWith("a");
	});

	it("draws a comment that is not posted yet as the next number, and not as a control", () => {
		mount({
			threads: [thread("a", { kind: "point", x: 5, y: 5 })],
			draft: { kind: "node", nodeId: "note-1" },
		});
		const draft = screen.getByTestId("canvas-comment-draft-pin");
		expect(draft.textContent?.trim()).toBe("2");
		expect(draft.tagName).not.toBe("BUTTON");
		expect(draft.getAttribute("aria-label")).toBe(
			"New comment, not posted yet",
		);
	});
});

describe("going to a thread", () => {
	it("asks for the camera to be centred on the pin and rings it", async () => {
		const threads = [thread("a", { kind: "node", nodeId: "note-1" })];
		const { oncenter, rerender } = mount({ threads });
		await rerender({ threads, goto: { commentId: "a", token: 1 } });
		await tick();
		expect(oncenter).toHaveBeenCalledWith({ x: 300, y: 100 });
		expect(pins()[0].classList.contains("pin--flash")).toBe(true);
	});

	it("goes once per request, not once per render", async () => {
		const threads = [thread("a", { kind: "point", x: 5, y: 5 })];
		const { oncenter, rerender } = mount({ threads });
		const request = { commentId: "a", token: 7 };
		await rerender({ threads, goto: request });
		await rerender({ threads: [...threads], goto: request });
		expect(oncenter).toHaveBeenCalledTimes(1);
	});

	it("goes nowhere for a thread that has no pin", async () => {
		const threads = [thread("a", { kind: "node", nodeId: "deleted" })];
		const { oncenter, rerender } = mount({ threads });
		await rerender({ threads, goto: { commentId: "a", token: 1 } });
		expect(oncenter).not.toHaveBeenCalled();
	});
});
