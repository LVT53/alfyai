/**
 * What a node-component test puts in place of `@xyflow/svelte`: stub components
 * for the three pieces that need a live flow, the position names, and a
 * `useSvelteFlow` whose two mutators are spies. Used as
 * `vi.mock("@xyflow/svelte", async () => (await import("../_test/xyflow-mock")).xyflowMock())`.
 */
import { vi } from "vitest";
import StubHandle from "./StubHandle.svelte";
import StubNodeToolbar from "./StubNodeToolbar.svelte";
import StubResizeControl from "./StubResizeControl.svelte";
import StubViewportPortal from "./StubViewportPortal.svelte";

export const flowSpies = {
	updateNodeData: vi.fn(),
	deleteElements: vi.fn(() =>
		Promise.resolve({ deletedNodes: [], deletedEdges: [] }),
	),
};

export function xyflowMock() {
	return {
		Handle: StubHandle,
		NodeResizeControl: StubResizeControl,
		NodeToolbar: StubNodeToolbar,
		Position: { Top: "top", Right: "right", Bottom: "bottom", Left: "left" },
		useSvelteFlow: () => flowSpies,
		ViewportPortal: StubViewportPortal,
	};
}
