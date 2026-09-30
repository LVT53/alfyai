import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasNode } from "$lib/shared/artifacts/canvas";
import { uiLanguage } from "$lib/stores/settings";
import AlfyChangeLayer from "./AlfyChangeLayer.svelte";

// Alfy's change drawn on its own, on a board whose screen and board coordinates
// are the same: the dashed frame while Alfy arranges, a ring on each touched
// block (strong for a moment, then resting), the pill at the corner of them, and
// where the stepper sends the camera. That it sits above a frame's children and
// glides with them is the e2e's (artifact-canvas-review.spec.ts).

beforeEach(() => {
	uiLanguage.set("en");
});
afterEach(() => {
	document.body.innerHTML = "";
});

function sticky(id: string, x: number, y: number): CanvasNode {
	return {
		id,
		type: "sticky",
		position: { x, y },
		width: 200,
		height: 100,
		data: { kind: "sticky", text: `note ${id}`, tone: "yellow" },
	};
}

const NODES: CanvasNode[] = [
	sticky("a", 100, 100),
	sticky("b", 500, 300),
	sticky("c", 900, 100),
];

type Props = Parameters<typeof render<typeof AlfyChangeLayer>>[1];

function mount(props: Record<string, unknown> = {}) {
	const callbacks = {
		oncenter: vi.fn(),
		onkeep: vi.fn(),
		onundo: vi.fn(),
		onredo: vi.fn(),
	};
	const view = render(AlfyChangeLayer, {
		nodes: NODES,
		viewport: { x: 0, y: 0, zoom: 1 },
		arrangingIds: null,
		touched: [],
		pulseIds: [],
		activeId: null,
		pill: null,
		goto: null,
		...callbacks,
		...props,
	} as unknown as Props);
	return { ...view, ...callbacks };
}

describe("the arranging frame", () => {
	it("goes around the blocks Alfy is arranging, padded, and says nothing to a screen reader", () => {
		mount({ arrangingIds: ["a", "b"] });
		const frame = screen.getByTestId("canvas-arranging-frame");
		expect(frame.getAttribute("aria-hidden")).toBe("true");
		// a: 100..300 x 100..200, b: 500..700 x 300..400; padded by 14.
		expect(frame.style.left).toBe("86px");
		expect(frame.style.top).toBe("86px");
		expect(frame.style.width).toBe("628px");
		expect(frame.style.height).toBe("328px");
	});

	it("is not drawn when Alfy is not arranging, or names nothing that is on the board", () => {
		mount({ arrangingIds: [] });
		expect(screen.queryByTestId("canvas-arranging-frame")).toBeNull();
	});
});

describe("the rings", () => {
	it("rings each touched block where it is, and rings a block that only a highlight named", () => {
		mount({ touched: ["a"], pulseIds: ["c"] });
		const rings = screen.getAllByTestId("canvas-alfy-ring");
		expect(rings.map((ring) => ring.getAttribute("data-node-id"))).toEqual([
			"a",
			"c",
		]);
		expect(rings[0].style.left).toBe("100px");
		expect(rings[0].style.width).toBe("200px");
	});

	it("rings strongly what just landed and lets a waiting block rest", () => {
		mount({ touched: ["a", "b"], pulseIds: ["a"] });
		const [a, b] = screen.getAllByTestId("canvas-alfy-ring");
		expect(a.classList.contains("ring--pulse")).toBe(true);
		expect(b.classList.contains("ring--pulse")).toBe(false);
	});

	it("marks the block the stepper is on", () => {
		mount({ touched: ["a", "b"], activeId: "b" });
		const [a, b] = screen.getAllByTestId("canvas-alfy-ring");
		expect(a.classList.contains("ring--active")).toBe(false);
		expect(b.classList.contains("ring--active")).toBe(true);
	});

	it("rings a frame more quietly: a big block tinted as loudly as a note is a slab", () => {
		mount({
			nodes: [
				...NODES,
				{
					id: "frame",
					type: "frame",
					position: { x: 0, y: 500 },
					width: 400,
					height: 300,
					data: { kind: "frame", label: "Sunday", width: 400, height: 300 },
				},
			],
			pulseIds: ["a", "frame"],
		});
		const rings = screen.getAllByTestId("canvas-alfy-ring");
		const of = (id: string) =>
			rings.find((ring) => ring.getAttribute("data-node-id") === id);
		expect(of("frame")?.classList.contains("ring--frame")).toBe(true);
		expect(of("a")?.classList.contains("ring--frame")).toBe(false);
	});

	// RV-3 Minor 10: a frame's name chip sits across its top edge, and a ring drawn
	// on that edge struck the name through.
	it("stands a frame's ring outside the name chip that sits across its top edge, so the name is not struck through", () => {
		mount({
			nodes: [
				...NODES,
				{
					id: "frame",
					type: "frame",
					position: { x: 0, y: 500 },
					width: 400,
					height: 300,
					data: { kind: "frame", label: "Sunday", width: 400, height: 300 },
				},
			],
			touched: ["frame", "a"],
		});
		const rings = screen.getAllByTestId("canvas-alfy-ring");
		const of = (id: string) =>
			rings.find((ring) => ring.getAttribute("data-node-id") === id);
		// The chip is 12 units above the edge; the ring is beyond it, all round.
		const frame = of("frame");
		expect(Number.parseFloat(frame?.style.top ?? "")).toBeLessThan(500 - 12);
		expect(Number.parseFloat(frame?.style.left ?? "")).toBeLessThan(0);
		expect(Number.parseFloat(frame?.style.width ?? "")).toBeGreaterThan(400);
		expect(Number.parseFloat(frame?.style.height ?? "")).toBeGreaterThan(300);
		// A note's ring stays on the note.
		expect(of("a")?.style.top).toBe("100px");
	});

	it("rings nothing once the change is decided, though the pill goes on following its blocks", () => {
		mount({
			touched: ["a", "b"],
			waiting: false,
			pill: { status: "undone", label: "Planned Sunday" },
		});
		expect(screen.queryAllByTestId("canvas-alfy-ring")).toHaveLength(0);
		expect(screen.getByTestId("canvas-change-pill").style.left).toBe("700px");
	});

	it("keeps a ring 2 px on screen at any zoom", () => {
		const { container } = mount({
			touched: ["a"],
			viewport: { x: 0, y: 0, zoom: 0.5 },
		});
		const layer = container.querySelector<HTMLElement>(".alfy-layer");
		expect(layer?.style.getPropertyValue("--inv")).toBe("2");
	});
});

describe("the pill", () => {
	it("sits at the top-right corner of the touched blocks' box, and keeps and undoes", async () => {
		const { onkeep, onundo } = mount({
			touched: ["a", "b"],
			pill: { status: "pending", label: "Planned Sunday" },
		});
		const anchor = screen.getByTestId("canvas-change-pill");
		// The box is 100..700 x 100..400: its top-right corner is (700, 100).
		expect(anchor.style.left).toBe("700px");
		expect(anchor.style.top).toBe("100px");
		expect(screen.getByRole("group", { name: /Planned Sunday/ })).toBeTruthy();
		await fireEvent.click(
			screen.getByRole("button", { name: "Keep Alfy's change" }),
		);
		expect(onkeep).toHaveBeenCalledTimes(1);
		await fireEvent.click(
			screen.getByRole("button", { name: "Undo Alfy's change" }),
		);
		expect(onundo).toHaveBeenCalledTimes(1);
	});

	// RV-3 Minor 2: the pill hung from the corner of the box that holds every touched
	// block, over blocks Alfy left alone when the change is spread over the board.
	it("does not sit over a block Alfy left alone: it hangs from a touched block's corner instead", () => {
		// The box holding a and b has its corner at (700, 100), where the pill (280 x 28,
		// 16 above it) would cover 420..700 x 56..84: a block that was not touched is there.
		mount({
			nodes: [...NODES, sticky("d", 600, 40)].map((node) =>
				node.id === "d" ? { ...node, height: 50 } : node,
			),
			touched: ["a", "b"],
			pill: { status: "pending", label: "Planned Sunday" },
		});
		const pill = screen.getByTestId("canvas-change-pill");
		expect(pill.style.left).toBe("300px");
		expect(pill.style.top).toBe("100px");
	});

	it("does not mind a frame under it: a frame is a backdrop", () => {
		mount({
			nodes: [
				...NODES,
				{
					id: "frame",
					type: "frame",
					position: { x: 400, y: 20 },
					width: 400,
					height: 100,
					data: { kind: "frame", label: "Sunday", width: 400, height: 100 },
				},
			],
			touched: ["a", "b"],
			pill: { status: "pending", label: "Planned Sunday" },
		});
		expect(screen.getByTestId("canvas-change-pill").style.left).toBe("700px");
	});

	it("offers Redo once it is undone", async () => {
		const { onredo } = mount({
			touched: ["a"],
			pill: { status: "undone", label: "Planned Sunday" },
		});
		await fireEvent.click(
			screen.getByRole("button", { name: "Redo Alfy's change" }),
		);
		expect(onredo).toHaveBeenCalledTimes(1);
	});

	it("stays where it was when the blocks it pointed at are gone (Undo took them away)", async () => {
		const { rerender } = mount({
			touched: ["a", "b"],
			pill: { status: "pending", label: "x" },
		});
		expect(screen.getByTestId("canvas-change-pill").style.left).toBe("700px");
		await rerender({ nodes: [sticky("c", 900, 100)] });
		await tick();
		expect(screen.getByTestId("canvas-change-pill").style.left).toBe("700px");
	});

	it("is not drawn without a change to decide", () => {
		mount({ touched: ["a"], pill: null });
		expect(screen.queryByTestId("canvas-change-pill")).toBeNull();
	});
});

describe("where focus goes when the change is decided", () => {
	it("lands on Redo when Alfy's change is undone and the button that was pressed is gone", async () => {
		const { rerender } = mount({
			touched: ["a"],
			pill: { status: "pending", label: "x" },
		});
		expect(document.activeElement).toBe(document.body);
		await rerender({ pill: { status: "undone", label: "x" } });
		await tick();
		await tick();
		expect(document.activeElement?.textContent?.trim()).toBe("Redo");
	});

	it("goes back to Undo when it is redone", async () => {
		const { rerender } = mount({
			touched: ["a"],
			pill: { status: "undone", label: "x" },
		});
		await rerender({ pill: { status: "pending", label: "x" } });
		await tick();
		await tick();
		expect(document.activeElement?.textContent?.trim()).toBe("Undo");
	});

	it("never takes the focus from something else the reader is doing", async () => {
		const field = document.createElement("textarea");
		document.body.append(field);
		const { rerender } = mount({
			touched: ["a"],
			pill: { status: "pending", label: "x" },
		});
		field.focus();
		await rerender({ pill: { status: "undone", label: "x" } });
		await tick();
		await tick();
		expect(document.activeElement).toBe(field);
	});

	it("puts a Kept change's focus on the board's first tool", async () => {
		const select = document.createElement("button");
		select.setAttribute("data-testid", "canvas-tool-select");
		document.body.append(select);
		const { rerender } = mount({
			touched: ["a"],
			pill: { status: "pending", label: "x" },
		});
		await rerender({ pill: { status: "kept", label: "x" } });
		await tick();
		await tick();
		expect(document.activeElement).toBe(select);
	});
});

// RV-3 Minor 2: a landing did not move the camera, so a change Alfy made off the
// side of the pane (or under the toolbar) was not seen. When none of it is in view
// after a landing, the camera goes to it.
describe("a landing that is out of view", () => {
	const pane = { width: 800, height: 600 };

	it("sends the camera to the change when none of it is on screen", async () => {
		const view = mount({
			touched: ["c"],
			paneSize: pane,
			landed: 0,
		});
		await view.rerender({ landed: 1 });
		// c is at 900..1100 x 100..200; the pane shows 0..800.
		expect(view.oncenter).toHaveBeenCalledWith({ x: 1000, y: 150 });
	});

	it("leaves the camera where it is when any of the change is in view", async () => {
		const view = mount({
			touched: ["a", "c"],
			paneSize: pane,
			landed: 0,
		});
		await view.rerender({ landed: 1 });
		expect(view.oncenter).not.toHaveBeenCalled();
	});

	it("does not move the camera for a change that was already there when the layer came up", async () => {
		const view = mount({
			touched: ["c"],
			paneSize: pane,
			landed: 3,
		});
		await tick();
		expect(view.oncenter).not.toHaveBeenCalled();
	});

	it("measures what is on screen against the camera, not the board", async () => {
		// Panned 700 to the right: the pane shows 700..1500, where c is.
		const view = mount({
			touched: ["c"],
			paneSize: pane,
			viewport: { x: -700, y: 0, zoom: 1 },
			landed: 0,
		});
		await view.rerender({ landed: 1 });
		expect(view.oncenter).not.toHaveBeenCalled();
	});
});

describe("where the stepper sends the camera", () => {
	it("centres on the block it was asked for, once per request", async () => {
		const { oncenter, rerender } = mount({ touched: ["a", "b"] });
		await rerender({ goto: { id: "b", token: 1 } });
		await tick();
		expect(oncenter).toHaveBeenCalledWith({ x: 600, y: 350 });
		await rerender({ nodes: [...NODES] });
		await tick();
		expect(oncenter).toHaveBeenCalledTimes(1);
		await rerender({ goto: { id: "b", token: 2 } });
		await tick();
		expect(oncenter).toHaveBeenCalledTimes(2);
	});

	it("does nothing for a block that is not there", async () => {
		const { oncenter, rerender } = mount({ touched: ["a"] });
		await rerender({ goto: { id: "gone", token: 1 } });
		await tick();
		expect(oncenter).not.toHaveBeenCalled();
	});
});
