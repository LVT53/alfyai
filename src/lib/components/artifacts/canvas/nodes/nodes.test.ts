import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/svelte";
import type { Component } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEXT_MAX_CHARS } from "$lib/shared/artifacts/canvas-blocks";
import { uiLanguage } from "$lib/stores/settings";
import type { CanvasBoardContext } from "../_lib/board-context";
import { keepInPicture } from "../_lib/poster";
import { broken } from "../_test/broken-content";
import ShellWithBrokenContent from "../_test/ShellWithBrokenContent.svelte";
import WithBoard from "../_test/WithBoard.svelte";
import { flowSpies, xyflowMock } from "../_test/xyflow-mock";
import ChartNode, { chartShell } from "./ChartNode.svelte";
import ChecklistNode, { checklistShell } from "./ChecklistNode.svelte";
import FrameNode from "./FrameNode.svelte";
import MermaidNode, { mermaidShell } from "./MermaidNode.svelte";
import MissingKindNode from "./MissingKindNode.svelte";
import StickyNode from "./StickyNode.svelte";
import TextNode from "./TextNode.svelte";

vi.mock("@xyflow/svelte", async () =>
	(await import("../_test/xyflow-mock")).xyflowMock(),
);
vi.mock("$lib/components/chat/Chart.svelte", async () => ({
	default: (await import("../_test/StubChart.svelte")).default,
}));
vi.mock("$lib/components/chat/Mermaid.svelte", async () => ({
	default: (await import("../_test/StubMermaid.svelte")).default,
}));

function board(
	overrides: Partial<CanvasBoardContext> = {},
): CanvasBoardContext {
	return {
		readonly: false,
		requestEdit() {},
		takeEditRequest: () => false,
		dropTargetId: null,
		// A block loaded on demand changes its data through the board, which hands it to the flow.
		updateData: (id, patch) => flowSpies.updateNodeData(id, patch),
		...overrides,
	};
}

function mount(
	// biome-ignore lint/suspicious/noExplicitAny: any node component, whatever its props
	component: Component<any>,
	componentProps: Record<string, unknown>,
	context: CanvasBoardContext = board(),
) {
	return render(WithBoard, { props: { component, componentProps, context } });
}

const stickyProps = (extra: Record<string, unknown> = {}) => ({
	id: "note-1",
	selected: false,
	data: { kind: "sticky", text: "Lunch at the market", tone: "yellow" },
	...extra,
});

beforeEach(() => {
	vi.clearAllMocks();
	uiLanguage.set("en");
	broken.on = true;
});

// The nodes are drawn here against a stand-in for the flow library, so the
// stand-in has to offer everything the shell and the nodes ask the library for:
// a new import in one of them that the stand-in lacks would show as "x is not a
// function" deep inside a render, instead of here.
describe("the flow stand-in", () => {
	it("offers every name the shell and the nodes import from the flow library", () => {
		const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
		const files = [
			path.join(root, "NodeShell.svelte"),
			...readdirSync(path.join(root, "nodes"))
				.filter((name) => name.endsWith(".svelte"))
				.map((name) => path.join(root, "nodes", name)),
		];
		const wanted = new Set<string>();
		for (const file of files) {
			const source = readFileSync(file, "utf8");
			for (const match of source.matchAll(
				/import\s*\{([^}]*)\}\s*from\s*"@xyflow\/svelte"/g,
			)) {
				for (const part of match[1].split(",")) {
					const name = part
						.trim()
						.replace(/^type\s+/, "")
						.split(/\s+as\s+/)[0];
					if (name && !part.trim().startsWith("type ")) wanted.add(name);
				}
			}
		}
		expect(wanted.size).toBeGreaterThan(3);
		expect(Object.keys(xyflowMock())).toEqual(
			expect.arrayContaining([...wanted]),
		);
	});
});

describe("the node shell around a block", () => {
	it("draws the four connection anchors and no resize corner while a block is not selected, and hides the anchors", () => {
		mount(StickyNode, stickyProps());
		const anchors = screen.getAllByTestId("canvas-anchor");
		expect(anchors).toHaveLength(4);
		for (const anchor of anchors) {
			expect(anchor.className).toContain("canvas-anchor");
			expect(anchor.className).not.toContain("canvas-anchor--shown");
		}
		expect(screen.queryAllByTestId("canvas-resize-handle")).toHaveLength(0);
		expect(screen.queryByTestId("canvas-node-toolbar")).toBeNull();
	});

	it("shows the anchors, four corner handles and the toolbar only while the block is selected", () => {
		mount(StickyNode, stickyProps({ selected: true }));
		for (const anchor of screen.getAllByTestId("canvas-anchor")) {
			expect(anchor.className).toContain("canvas-anchor--shown");
		}
		const corners = screen.getAllByTestId("canvas-resize-handle");
		expect(corners.map((corner) => corner.dataset.position).sort()).toEqual([
			"bottom-left",
			"bottom-right",
			"top-left",
			"top-right",
		]);
		expect(screen.getByTestId("canvas-node-toolbar")).toBeInTheDocument();
		// A note is resized by its corners only.
		for (const corner of corners) expect(corner.dataset.variant).toBe("handle");
	});

	it("gives the connections one way in and one way out per axis, so a stored edge with no handle ids has somewhere to attach", () => {
		mount(StickyNode, stickyProps());
		const byPosition = Object.fromEntries(
			screen
				.getAllByTestId("canvas-anchor")
				.map((anchor) => [anchor.dataset.position, anchor.dataset.handleType]),
		);
		expect(byPosition).toEqual({
			bottom: "source",
			right: "source",
			top: "target",
			left: "target",
		});
	});

	it("draws no anchors, corners or toolbar while the board is read-only, even for a selected block", () => {
		mount(
			StickyNode,
			stickyProps({ selected: true }),
			board({ readonly: true }),
		);
		for (const anchor of screen.getAllByTestId("canvas-anchor")) {
			expect(anchor.className).not.toContain("canvas-anchor--shown");
		}
		expect(screen.queryAllByTestId("canvas-resize-handle")).toHaveLength(0);
		expect(screen.queryByTestId("canvas-node-toolbar")).toBeNull();
	});

	it("deletes the block from the selection toolbar", async () => {
		mount(StickyNode, stickyProps({ selected: true }));
		await fireEvent.click(screen.getByTestId("canvas-node-delete"));
		expect(flowSpies.deleteElements).toHaveBeenCalledWith({
			nodes: [{ id: "note-1" }],
		});
	});

	it("names the node for a screen reader from what it says, and its kind", () => {
		mount(StickyNode, stickyProps());
		const wrapper = screen.getByTestId("node-wrapper");
		expect(wrapper).toHaveAttribute(
			"aria-label",
			"Sticky note: Lunch at the market",
		);
		expect(wrapper).toHaveAttribute("aria-roledescription", "Sticky note");
	});

	it("names it in Hungarian in Hungarian", () => {
		uiLanguage.set("hu");
		mount(StickyNode, stickyProps());
		expect(screen.getByTestId("node-wrapper")).toHaveAttribute(
			"aria-label",
			"Jegyzet: Lunch at the market",
		);
	});
});

// RV-3 C1: nothing about one block's content may take the board down. A block
// whose content throws while it is drawn was, before this, an error the whole
// panel died of (it stayed on its loading skeleton, and could only be deleted).
describe("a block whose content cannot be drawn", () => {
	it("says so in its own place and keeps its shell, instead of throwing to the board", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		mount(ShellWithBrokenContent, {});
		const notice = screen.getByTestId("canvas-node-broken");
		expect(notice).toHaveAttribute("role", "alert");
		expect(notice).toHaveTextContent("This block could not be drawn.");
		// Its name and its anchors are still there: an edge can attach, it can be selected and deleted.
		expect(screen.getByText("Budget")).toBeInTheDocument();
		expect(screen.getAllByTestId("canvas-anchor")).toHaveLength(4);
		expect(screen.queryByTestId("content-recovered")).toBeNull();
	});

	it("says it in Hungarian in Hungarian", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		uiLanguage.set("hu");
		mount(ShellWithBrokenContent, {});
		expect(screen.getByTestId("canvas-node-broken")).toHaveTextContent(
			"Ezt a blokkot nem sikerült megrajzolni.",
		);
	});

	it("draws the block again when the reader tries again and it can be drawn", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		mount(ShellWithBrokenContent, {});
		broken.on = false;
		await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(await screen.findByTestId("content-recovered")).toBeInTheDocument();
		expect(screen.queryByTestId("canvas-node-broken")).toBeNull();
	});

	it("reports what went wrong once, to the console, with the block it was", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		mount(ShellWithBrokenContent, { id: "chart-7" });
		expect(error).toHaveBeenCalledTimes(1);
		expect(error.mock.calls[0]).toContain("chart-7");
	});
});

describe("a sticky note", () => {
	it("shows no redundant header, only its words", () => {
		const { container } = mount(StickyNode, stickyProps());
		expect(container.querySelector(".canvas-node__head")).toBeNull();
		expect(container.querySelector("svg")).toBeNull();
		expect(screen.getByText("Lunch at the market")).toBeInTheDocument();
	});

	it("opens for editing on a double-click, with the schema's own limit on the field", async () => {
		mount(StickyNode, stickyProps());
		expect(screen.queryByRole("textbox")).toBeNull();
		await fireEvent.dblClick(screen.getByTestId("canvas-sticky"));
		const field = screen.getByRole("textbox", { name: "Sticky note" });
		expect(field).toHaveValue("Lunch at the market");
		expect(field).toHaveAttribute("maxlength", String(TEXT_MAX_CHARS));
		expect(field).toHaveFocus();
	});

	it("opens for editing from the Edit button of the selection's toolbar, which is how a reader who does not know to double-click finds it", async () => {
		mount(StickyNode, stickyProps({ selected: true }));
		expect(screen.queryByRole("textbox")).toBeNull();
		const edit = screen.getByTestId("canvas-node-edit");
		expect(edit).toHaveAccessibleName("Edit");
		await fireEvent.click(edit);
		expect(screen.getByRole("textbox", { name: "Sticky note" })).toHaveFocus();
	});

	it("has the whole note, however tall it was made, to double-click on", () => {
		mount(StickyNode, stickyProps());
		const style = readFileSync(
			path.join(
				path.dirname(fileURLToPath(import.meta.url)),
				"StickyNode.svelte",
			),
			"utf8",
		);
		// What a double-click edits is the paper, not just the lines of words on it.
		expect(style).toMatch(/\.sticky\s*\{[^}]*height:\s*100%/);
	});

	it("opens for editing on Enter while the node itself has focus, and not on Enter from elsewhere", async () => {
		mount(StickyNode, stickyProps());
		const wrapper = screen.getByTestId("node-wrapper");
		wrapper.focus();
		await fireEvent.keyDown(wrapper, { key: "Enter" });
		expect(screen.getByRole("textbox")).toBeInTheDocument();
	});

	it("saves what is typed through the flow's node-data update, as plain text", async () => {
		mount(StickyNode, stickyProps());
		await fireEvent.dblClick(screen.getByTestId("canvas-sticky"));
		const field = screen.getByRole("textbox");
		await fireEvent.input(field, { target: { value: "<b>Brunch</b> at 10" } });
		expect(flowSpies.updateNodeData).toHaveBeenCalledWith("note-1", {
			text: "<b>Brunch</b> at 10",
		});
	});

	it("ends the edit on Escape and gives focus back to the node", async () => {
		mount(StickyNode, stickyProps());
		await fireEvent.dblClick(screen.getByTestId("canvas-sticky"));
		await fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(screen.getByTestId("node-wrapper")).toHaveFocus();
	});

	it("does not open while the board is read-only", async () => {
		mount(StickyNode, stickyProps(), board({ readonly: true }));
		await fireEvent.dblClick(screen.getByTestId("canvas-sticky"));
		expect(screen.queryByRole("textbox")).toBeNull();
	});

	it("opens at once when the board asked it to (a note that was just inserted)", () => {
		const asked = new Set(["note-1"]);
		mount(
			StickyNode,
			stickyProps(),
			board({ takeEditRequest: (id) => asked.delete(id) }),
		);
		expect(screen.getByRole("textbox")).toBeInTheDocument();
	});

	it("changes its tone from the selection toolbar, and says which tone it has", async () => {
		mount(StickyNode, stickyProps({ selected: true }));
		const swatches = screen.getAllByTestId("canvas-sticky-tone");
		expect(swatches.map((swatch) => swatch.dataset.tone)).toEqual([
			"yellow",
			"mint",
			"blue",
			"plain",
		]);
		expect(swatches[0]).toHaveAttribute("aria-pressed", "true");
		expect(swatches[1]).toHaveAttribute("aria-pressed", "false");
		await fireEvent.click(screen.getByRole("button", { name: "Mint" }));
		expect(flowSpies.updateNodeData).toHaveBeenCalledWith("note-1", {
			tone: "mint",
		});
	});
});

describe("a text block", () => {
	const props = (extra: Record<string, unknown> = {}) => ({
		id: "text-1",
		selected: false,
		data: { kind: "text", text: "Weekend plan" },
		...extra,
	});

	it("shows no header and no type glyph, only its words", () => {
		const { container } = mount(TextNode, props());
		expect(container.querySelector(".canvas-node__head")).toBeNull();
		expect(container.querySelector("svg")).toBeNull();
		expect(screen.getByText("Weekend plan")).toBeInTheDocument();
	});

	it("says what to do when it is empty", () => {
		mount(TextNode, props({ data: { kind: "text", text: "" } }));
		expect(screen.getByText("Write something…")).toBeInTheDocument();
	});

	it("opens for editing from the Edit button of the selection's toolbar", async () => {
		mount(TextNode, props({ selected: true }));
		await fireEvent.click(screen.getByTestId("canvas-node-edit"));
		expect(screen.getByRole("textbox", { name: "Text" })).toHaveFocus();
	});

	it("has the whole block, however tall it was made, to double-click on", () => {
		const style = readFileSync(
			path.join(
				path.dirname(fileURLToPath(import.meta.url)),
				"TextNode.svelte",
			),
			"utf8",
		);
		expect(style).toMatch(/\.text-block\s*\{[^}]*height:\s*100%/);
	});

	it("edits in place with the same limit as a note", async () => {
		mount(TextNode, props());
		await fireEvent.dblClick(screen.getByTestId("canvas-text"));
		const field = screen.getByRole("textbox", { name: "Text" });
		expect(field).toHaveAttribute("maxlength", String(TEXT_MAX_CHARS));
		await fireEvent.input(field, { target: { value: "Plan B" } });
		expect(flowSpies.updateNodeData).toHaveBeenCalledWith("text-1", {
			text: "Plan B",
		});
	});
});

describe("a frame", () => {
	const props = (extra: Record<string, unknown> = {}) => ({
		id: "frame-1",
		selected: false,
		data: { kind: "frame", label: "Saturday", width: 360, height: 260 },
		...extra,
	});

	it("shows its name on a chip, which is what the board drags it by", () => {
		mount(FrameNode, props());
		const chip = screen.getByTestId("canvas-frame-label");
		expect(chip).toHaveTextContent("Saturday");
		expect(chip.closest(".canvas-node__chip")).not.toBeNull();
	});

	it("renames from the Edit button of the selection's toolbar, and its toolbar is lifted above the board's pane so every button of it can be pressed", async () => {
		mount(FrameNode, props({ selected: true }));
		await fireEvent.click(screen.getByTestId("canvas-node-edit"));
		expect(screen.getByRole("textbox", { name: "Frame name" })).toHaveFocus();
		// The library lifts a toolbar to its block's layer plus one, which for a frame (behind
		// everything) is 0, under the pane: the layer the toolbar gets is the frame's own class.
		const shell = readFileSync(
			path.join(
				path.dirname(fileURLToPath(import.meta.url)),
				"..",
				"NodeShell.svelte",
			),
			"utf8",
		);
		expect(shell).toContain("' canvas-toolbar--frame'");
		expect(shell).toMatch(
			/\.svelte-flow__node-toolbar\.canvas-toolbar--frame\)\s*\{[^}]*z-index:\s*6\s*!important/,
		);
	});

	it("renames in place, within the label limit, on a double-click", async () => {
		mount(FrameNode, props());
		await fireEvent.dblClick(screen.getByTestId("canvas-frame-label"));
		const field = screen.getByRole("textbox", { name: "Frame name" });
		expect(field).toHaveAttribute("maxlength", "500");
		await fireEvent.input(field, { target: { value: "Sunday" } });
		expect(flowSpies.updateNodeData).toHaveBeenCalledWith("frame-1", {
			label: "Sunday",
		});
	});

	it("shows a muted prompt for a frame with no name", () => {
		mount(
			FrameNode,
			props({ data: { kind: "frame", label: "", width: 360, height: 260 } }),
		);
		expect(screen.getByTestId("canvas-frame-label")).toHaveTextContent(
			"Frame name",
		);
	});

	it("is resized from its four corners and its four sides while it is selected, and from neither before", () => {
		mount(FrameNode, props());
		expect(screen.queryAllByTestId("canvas-resize-handle")).toHaveLength(0);
		cleanup();
		mount(FrameNode, props({ selected: true }));
		const controls = screen.getAllByTestId("canvas-resize-handle");
		expect(controls).toHaveLength(8);
		const sides = controls.filter(
			(control) => control.dataset.variant === "line",
		);
		expect(sides.map((side) => side.dataset.position).sort()).toEqual([
			"bottom",
			"left",
			"right",
			"top",
		]);
		const corners = controls.filter(
			(control) => control.dataset.variant === "handle",
		);
		expect(corners.map((corner) => corner.dataset.position).sort()).toEqual([
			"bottom-left",
			"bottom-right",
			"top-left",
			"top-right",
		]);
	});

	it("draws no resize control on a board that cannot change", () => {
		mount(FrameNode, props({ selected: true }), board({ readonly: true }));
		expect(screen.queryAllByTestId("canvas-resize-handle")).toHaveLength(0);
	});

	it("asks the board how small each control may bring it, and never less than its own smallest", () => {
		const resizeFloor = vi.fn((_id: string, position: string) => ({
			width: position.includes("right")
				? 300
				: position.includes("left")
					? 90
					: 0,
			height: position.includes("bottom") ? 200 : 0,
		}));
		mount(FrameNode, props({ selected: true }), board({ resizeFloor }));
		const byPosition = Object.fromEntries(
			screen
				.getAllByTestId("canvas-resize-handle")
				.map((control) => [
					`${control.dataset.variant}:${control.dataset.position}`,
					[control.dataset.minWidth, control.dataset.minHeight],
				]),
		);
		// A frame is never smaller than 160 x 120, whatever the board says.
		expect(byPosition["line:right"]).toEqual(["300", "120"]);
		expect(byPosition["line:left"]).toEqual(["160", "120"]);
		expect(byPosition["line:bottom"]).toEqual(["160", "200"]);
		expect(byPosition["handle:bottom-right"]).toEqual(["300", "200"]);
		expect(byPosition["handle:top-left"]).toEqual(["160", "120"]);
		expect(resizeFloor).toHaveBeenCalledWith("frame-1", "right");
	});

	it("hands the undo chord to the board while nothing has been typed in its name", async () => {
		const history = vi.fn();
		mount(FrameNode, props(), board({ history }));
		await fireEvent.dblClick(screen.getByTestId("canvas-frame-label"));
		const field = screen.getByRole("textbox", { name: "Frame name" });
		await fireEvent.keyDown(field, { key: "z", code: "KeyZ", ctrlKey: true });
		expect(history).toHaveBeenCalledWith("undo");
	});

	it("keeps the undo chord for the name once something has been typed in it", async () => {
		const history = vi.fn();
		mount(FrameNode, props(), board({ history }));
		await fireEvent.dblClick(screen.getByTestId("canvas-frame-label"));
		const field = screen.getByRole("textbox", { name: "Frame name" });
		await fireEvent.input(field, { target: { value: "Sunday" } });
		await fireEvent.keyDown(field, { key: "z", code: "KeyZ", ctrlKey: true });
		expect(history).not.toHaveBeenCalled();
	});
});

describe("the board's own checklist", () => {
	const items = [
		{ id: "i1", text: "Passport", done: true },
		{ id: "i2", text: "Charger", done: false },
	];
	const props = (extra: Record<string, unknown> = {}) => ({
		id: "todo-1",
		selected: false,
		data: { kind: "checklist", label: "Pack", items },
		...extra,
	});

	it("ticks a box as an edit of the node's data, leaving every other item as it was", async () => {
		mount(ChecklistNode, props());
		const box = screen.getByRole("checkbox", { name: "Charger: toggle done" });
		expect(box).not.toBeDisabled();
		expect(box).not.toBeChecked();
		await fireEvent.click(box);
		expect(flowSpies.updateNodeData).toHaveBeenCalledWith("todo-1", {
			items: [
				{ id: "i1", text: "Passport", done: true },
				{ id: "i2", text: "Charger", done: true },
			],
		});
		// The data it was handed is never mutated: the flow owns the state.
		expect(items[1].done).toBe(false);
	});

	it("shows the ticks it was given", () => {
		mount(ChecklistNode, props());
		expect(
			screen.getByRole("checkbox", { name: "Passport: toggle done" }),
		).toBeChecked();
	});

	// RC-3 N5: the picture of the board is of what the board holds, not of the tools
	// the reader edits it with: the row a new item is typed in, and each item's remove
	// button, are left out of it.
	it("leaves the reader's tools out of a picture of the board: the add row and the remove buttons", () => {
		mount(ChecklistNode, props());
		const addRow = screen.getByPlaceholderText("New item").closest("div");
		expect(addRow).not.toBeNull();
		expect(keepInPicture(addRow as Element)).toBe(false);
		const removes = screen.getAllByRole("button", { name: "Remove item" });
		expect(removes).toHaveLength(items.length);
		for (const button of removes) expect(keepInPicture(button)).toBe(false);
		// The items themselves are the board's content.
		expect(
			keepInPicture(screen.getByRole("checkbox", { name: /Passport/ })),
		).toBe(true);
	});

	// RV-3 C1: the rows were keyed by item id, and Svelte throws for a repeated key
	// (in production too). The server repairs a repeated id on read now; the rows
	// must not depend on that to draw.
	it("draws every item when two of them share an id, and a tick changes only the one that was ticked", async () => {
		const doubled = [
			{ id: "1", text: "First thing", done: false },
			{ id: "1", text: "Second thing", done: false },
		];
		mount(
			ChecklistNode,
			props({ data: { kind: "checklist", label: "Doubled", items: doubled } }),
		);
		expect(screen.getAllByRole("checkbox")).toHaveLength(2);
		await fireEvent.click(
			screen.getByRole("checkbox", { name: "Second thing: toggle done" }),
		);
		expect(flowSpies.updateNodeData).toHaveBeenCalledWith("todo-1", {
			items: [
				{ id: "1", text: "First thing", done: false },
				{ id: "1", text: "Second thing", done: true },
			],
		});
	});

	it("dresses the shell with its label and how many of its items are done", () => {
		expect(checklistShell({ kind: "checklist", label: "Pack", items })).toEqual(
			{
				title: "Pack",
				meta: "1/2",
				summary: "Pack",
				editable: true,
			},
		);
		expect(checklistShell({ kind: "checklist", items: [] })).toEqual({
			title: "",
			meta: "",
			summary: "",
			editable: true,
		});
	});

	it("adds an item on Enter, trimmed, with an id of its own, and ignores an empty one", async () => {
		mount(ChecklistNode, props());
		const field = screen.getByRole("textbox", { name: "New item" });
		await fireEvent.input(field, { target: { value: "   " } });
		await fireEvent.keyDown(field, { key: "Enter" });
		expect(flowSpies.updateNodeData).not.toHaveBeenCalled();
		await fireEvent.input(field, { target: { value: "  Adapter " } });
		await fireEvent.keyDown(field, { key: "Enter" });
		expect(flowSpies.updateNodeData).toHaveBeenCalledTimes(1);
		const [, patch] = flowSpies.updateNodeData.mock.calls[0] as [
			string,
			{ items: { id: string; text: string; done: boolean }[] },
		];
		expect(patch.items).toHaveLength(3);
		expect(patch.items[2]).toMatchObject({ text: "Adapter", done: false });
		expect(patch.items[2].id.length).toBeGreaterThan(0);
		expect(items.map((item) => item.id)).not.toContain(patch.items[2].id);
	});

	it("limits an item's text to what the schema keeps, and stops offering to add at the item cap", () => {
		const { unmount } = mount(ChecklistNode, props());
		for (const field of screen.getAllByRole("textbox", { name: "Checklist" })) {
			expect(field).toHaveAttribute("maxlength", "1000");
		}
		unmount();
		const many = Array.from({ length: 200 }, (_, index) => ({
			id: `i${index}`,
			text: `Item ${index}`,
			done: false,
		}));
		mount(ChecklistNode, props({ data: { kind: "checklist", items: many } }));
		expect(screen.queryByRole("textbox", { name: "New item" })).toBeNull();
	});

	it("removes an item, and an item cleared by the reader", async () => {
		mount(ChecklistNode, props());
		const within0 = within(screen.getAllByRole("listitem")[0]);
		await fireEvent.click(within0.getByRole("button", { name: "Remove item" }));
		expect(flowSpies.updateNodeData).toHaveBeenLastCalledWith("todo-1", {
			items: [items[1]],
		});
		const field = screen.getAllByRole("textbox", { name: "Checklist" })[1];
		await fireEvent.input(field, { target: { value: "" } });
		await fireEvent.change(field, { target: { value: "" } });
		expect(flowSpies.updateNodeData).toHaveBeenLastCalledWith("todo-1", {
			items: [items[0]],
		});
	});

	it("says once, while it is selected, that a tick here is saved with the board", () => {
		const { unmount } = mount(ChecklistNode, props());
		expect(
			screen.queryByText("Ticks here are saved with the board."),
		).toBeNull();
		unmount();
		mount(ChecklistNode, props({ selected: true }));
		expect(
			screen.getAllByText("Ticks here are saved with the board."),
		).toHaveLength(1);
	});

	it("is read-only, boxes and all, while the board is", () => {
		mount(ChecklistNode, props(), board({ readonly: true }));
		expect(
			screen.getByRole("checkbox", { name: "Charger: toggle done" }),
		).toBeDisabled();
		expect(screen.queryByRole("textbox", { name: "New item" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Remove item" })).toBeNull();
	});

	it("has its own tickable component and never imports the chat's read-only checklist", () => {
		const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
		const sources: string[] = [];
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const full = path.join(dir, name);
				if (statSync(full).isDirectory()) walk(full);
				else if (/\.(svelte|ts)$/.test(name) && !/\.test\.ts$/.test(name)) {
					sources.push(full);
				}
			}
		};
		walk(root);
		expect(sources.length).toBeGreaterThan(5);
		for (const file of sources) {
			// An import of it, in any spelling; a comment may name it.
			expect(readFileSync(file, "utf8"), file).not.toMatch(
				/(?:from|import\s*\()\s*["'][^"']*chat\/Checklist/,
			);
		}
	});
});

describe("a chart block", () => {
	it("hands the chat's chart exactly the code the chat hands it, and no other prop", () => {
		const code =
			'{"type":"bar","data":{"labels":["A"],"datasets":[{"data":[1]}]}}';
		mount(ChartNode, {
			id: "chart-1",
			selected: false,
			data: { kind: "chart", label: "Budget", code },
		});
		const chart = screen.getByTestId("chart-stub");
		expect(chart).toHaveAttribute("data-code", code);
		expect(chart).toHaveAttribute("data-prop-names", '["code"]');
	});

	it("dresses the shell with its label and its subtitle, and with nothing when it has neither", () => {
		expect(
			chartShell({
				kind: "chart",
				label: "Budget",
				subtitle: "Q3",
				code: "{}",
			}),
		).toEqual({
			title: "Budget",
			meta: "Q3",
			summary: "Budget",
			editable: true,
		});
		expect(chartShell({ kind: "chart", code: "{}" })).toEqual({
			title: "",
			meta: "",
			summary: "",
			editable: true,
		});
	});
});

describe("a diagram block", () => {
	it("hands the chat's Mermaid exactly the source the chat hands it, and no other prop", () => {
		const code = "flowchart TD\n  A[Start] --> B{Valid?}";
		mount(MermaidNode, {
			id: "diagram-1",
			selected: false,
			data: { kind: "mermaid", label: "Checkout", code },
		});
		const diagram = screen.getByTestId("mermaid-stub");
		expect(diagram).toHaveAttribute("data-code", code);
		expect(diagram).toHaveAttribute("data-prop-names", '["code"]');
		expect(screen.getByTestId("canvas-mermaid")).toContainElement(diagram);
	});

	it("dresses the shell with its label and its subtitle, and with nothing when it has neither", () => {
		expect(
			mermaidShell({
				kind: "mermaid",
				label: "Checkout",
				subtitle: "v2",
				code: "flowchart TD",
			}),
		).toEqual({
			title: "Checkout",
			meta: "v2",
			summary: "Checkout",
			editable: true,
		});
		expect(mermaidShell({ kind: "mermaid", code: "flowchart TD" })).toEqual({
			title: "",
			meta: "",
			summary: "",
			editable: true,
		});
	});
});

describe("a block whose kind this build cannot draw", () => {
	it("draws the missing-kind card, in the reader's language, and stays a real node", () => {
		const { container } = mount(MissingKindNode, {
			id: "hologram-1",
			type: "hologram",
			selected: false,
		});
		expect(container.querySelector('[data-missing="true"]')).not.toBeNull();
		expect(
			screen.getByText("This block's type is not supported any more."),
		).toBeInTheDocument();
		expect(screen.getAllByTestId("canvas-anchor")).toHaveLength(4);
	});

	it("says it in Hungarian too", () => {
		uiLanguage.set("hu");
		mount(MissingKindNode, {
			id: "hologram-1",
			type: "hologram",
			selected: false,
		});
		expect(
			screen.getByText("Ez a blokktípus már nem támogatott."),
		).toBeInTheDocument();
	});
});
