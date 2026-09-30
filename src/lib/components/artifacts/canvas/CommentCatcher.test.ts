import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasNode } from "$lib/shared/artifacts/canvas";
import { uiLanguage } from "$lib/stores/settings";
import type { Tool } from "./_lib/annotations";
import CommentCatcher from "./CommentCatcher.svelte";

// The Comment tool's catcher on its own, on a board whose screen and board
// coordinates are the same (identity conversion): what a click does to it and
// what it hands back. That it really covers the whole pane, and sits above the
// blocks and under the library's panels, is the e2e's.

beforeEach(() => {
	uiLanguage.set("en");
});

afterEach(() => {
	document.body.innerHTML = "";
});

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

function mount(props: Partial<{ nodes: CanvasNode[]; tool: Tool }> = {}) {
	const callbacks = {
		ondraft: vi.fn(),
		ontoolchange: vi.fn(),
		onannounce: vi.fn(),
	};
	// The keyboard escape only acts when the focus is inside the board.
	const board = document.createElement("div");
	board.dataset.testid = "canvas-board";
	document.body.appendChild(board);
	const view = render(CommentCatcher, {
		target: board,
		props: {
			nodes: NODES,
			tool: "select",
			toBoard: (point: { x: number; y: number }) => point,
			...callbacks,
			...props,
		},
	});
	return { ...view, ...callbacks, board };
}

describe("the Comment tool's catcher", () => {
	it("is not there until the tool is armed", () => {
		mount({ tool: "select" });
		expect(screen.queryByTestId("canvas-comment-catcher")).toBeNull();
	});

	it("is a button over the pane that says what a click will do", () => {
		mount({ tool: "comment" });
		expect(
			screen.getByRole("button", {
				name: "Click the board to place a comment, or a block to comment on it.",
			}),
		).toBeTruthy();
	});

	it("places a spot where the pane was clicked, in board coordinates, and hands the tool back", async () => {
		const { ondraft, ontoolchange, onannounce } = mount({
			tool: "comment",
			// A board panned by (-100, -50): the screen point (350, 250) is board (450, 300)... offset by the pan.
			nodes: [],
		});
		const catcher = screen.getByTestId("canvas-comment-catcher");
		await fireEvent.click(catcher, { clientX: 350, clientY: 250, detail: 1 });
		expect(ondraft).toHaveBeenCalledWith({ kind: "point", x: 350, y: 250 });
		expect(ontoolchange).toHaveBeenCalledWith("select");
		expect(onannounce).toHaveBeenCalledWith(
			"Comment started. Write it in the comments list.",
		);
	});

	it("converts the click with the board's own conversion, not by assuming the camera", async () => {
		const ondraft = vi.fn();
		const board = document.createElement("div");
		board.dataset.testid = "canvas-board";
		document.body.appendChild(board);
		render(CommentCatcher, {
			target: board,
			props: {
				nodes: [],
				tool: "comment",
				toBoard: (point: { x: number; y: number }) => ({
					x: point.x / 2,
					y: point.y / 2,
				}),
				ondraft,
				ontoolchange: vi.fn(),
				onannounce: vi.fn(),
			},
		});
		await fireEvent.click(screen.getByTestId("canvas-comment-catcher"), {
			clientX: 300,
			clientY: 120,
			detail: 1,
		});
		expect(ondraft).toHaveBeenCalledWith({ kind: "point", x: 150, y: 60 });
	});

	it("comments on the block a click lands on", async () => {
		const { ondraft } = mount({ tool: "comment" });
		// note-1 is at (100, 100), 200 x 100.
		await fireEvent.click(screen.getByTestId("canvas-comment-catcher"), {
			clientX: 150,
			clientY: 140,
			detail: 1,
		});
		expect(ondraft).toHaveBeenCalledWith({ kind: "node", nodeId: "note-1" });
	});

	it("takes a click inside a frame's empty inside for a spot: a frame is commented on by selecting it", async () => {
		const { ondraft } = mount({ tool: "comment" });
		await fireEvent.click(screen.getByTestId("canvas-comment-catcher"), {
			clientX: 500,
			clientY: 400,
			detail: 1,
		});
		expect(ondraft).toHaveBeenCalledWith({ kind: "point", x: 500, y: 400 });
	});

	it("places a spot in the middle of the pane for a keyboard press, which has no pointer position", async () => {
		const { ondraft } = mount({ tool: "comment", nodes: [] });
		const catcher = screen.getByTestId("canvas-comment-catcher");
		catcher.getBoundingClientRect = () =>
			({
				left: 0,
				top: 0,
				width: 800,
				height: 600,
				right: 800,
				bottom: 600,
			}) as DOMRect;
		// A key press activates a button with `detail` 0.
		await fireEvent.click(catcher, { detail: 0 });
		expect(ondraft).toHaveBeenCalledWith({ kind: "point", x: 400, y: 300 });
	});

	it("puts the comment on the selected block at once when the tool is armed with one selected", async () => {
		const selected = [{ ...sticky("note-1", 100, 100), selected: true }, FRAME];
		const { ondraft, ontoolchange, rerender } = mount({
			tool: "select",
			nodes: selected,
		});
		expect(ondraft).not.toHaveBeenCalled();
		await rerender({ tool: "comment", nodes: selected });
		await tick();
		expect(ondraft).toHaveBeenCalledWith({ kind: "node", nodeId: "note-1" });
		expect(ontoolchange).toHaveBeenCalledWith("select");
	});

	it("lets go of the tool on Escape while the focus is on the board", async () => {
		const { ontoolchange } = mount({ tool: "comment" });
		screen.getByTestId("canvas-comment-catcher").focus();
		await fireEvent.keyDown(window, { key: "Escape" });
		expect(ontoolchange).toHaveBeenCalledWith("select");
	});

	it("leaves Escape alone when it is not armed", async () => {
		const { ontoolchange } = mount({ tool: "select" });
		await fireEvent.keyDown(window, { key: "Escape" });
		expect(ontoolchange).not.toHaveBeenCalled();
	});
});
