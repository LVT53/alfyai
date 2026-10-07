import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import type { CanvasBoardContext } from "../_lib/board-context";
import WithChat from "../_test/WithChat.svelte";
import { flowSpies } from "../_test/xyflow-mock";
import LazyNode from "./LazyNode.svelte";

// Every block that can be changed after it was inserted, drawn the way the board draws
// it (through `LazyNode`, the real loaders, a stand-in for the flow library): the
// toolbar's Edit button opens the block's form, a chart's and a diagram's replaces the
// content, a title-only form lies over it, Save writes what changed as one change to
// the block's data, and Cancel writes nothing.

vi.mock("@xyflow/svelte", async () =>
	(await import("../_test/xyflow-mock")).xyflowMock(),
);
vi.mock("$lib/components/chat/Chart.svelte", async () => ({
	default: (await import("../_test/StubChart.svelte")).default,
}));
vi.mock("$lib/components/chat/Mermaid.svelte", async () => ({
	default: (await import("../_test/StubMermaid.svelte")).default,
}));
vi.mock("$lib/components/chat/MapRouteCard.svelte", async () => ({
	default: (await import("../_test/StubMapRouteCard.svelte")).default,
}));
vi.mock("$lib/client/api/artifacts", () => ({
	fetchArtifact: () =>
		Promise.resolve({
			artifact: { id: "app-7", kind: "app", versionNumber: 3 },
			versions: [],
			comments: [],
		}),
	subscribeArtifactChanges: () => () => {},
	readAppValue: vi.fn(),
	writeAppValue: vi.fn(),
}));

function board(
	overrides: Partial<CanvasBoardContext> = {},
): CanvasBoardContext {
	return {
		readonly: false,
		requestEdit() {},
		takeEditRequest: () => false,
		dropTargetId: null,
		updateData: (id, patch) => flowSpies.updateNodeData(id, patch),
		...overrides,
	};
}

type Case = {
	kind: string;
	data: Record<string, unknown>;
	/** The test id of what the block draws when it is not being edited. */
	content: string;
	/** True when the form takes the content's place; false when it lies over it. */
	replaces: boolean;
	/** What Save writes after the title field is typed over with "Weekend plan". */
	patch: Record<string, unknown>;
};

const MAP = {
	mode: "drive",
	distanceM: 27_000,
	durationS: 2040,
	bounds: { minLat: 51.7, minLng: -8.5, maxLat: 51.9, maxLng: -8.4 },
	markers: [],
	polyline: [],
	attribution: "© OpenStreetMap contributors",
};

const CASES: Case[] = [
	{
		kind: "chart",
		data: { kind: "chart", code: '{"type":"bar","data":{}}' },
		content: "canvas-chart",
		replaces: true,
		patch: { label: "Weekend plan" },
	},
	{
		kind: "mermaid",
		data: { kind: "mermaid", code: "flowchart TD\n  A --> B" },
		content: "canvas-mermaid",
		replaces: true,
		patch: { label: "Weekend plan" },
	},
	{
		kind: "checklist",
		data: { kind: "checklist", items: [] },
		content: "canvas-checklist",
		replaces: false,
		patch: { label: "Weekend plan" },
	},
	{
		kind: "map",
		data: { kind: "map", route: "Cork → Kinsale", map: MAP },
		content: "canvas-map",
		replaces: false,
		patch: { label: "Weekend plan" },
	},
	{
		kind: "app",
		data: { kind: "app", artifactId: "app-7", title: "Tip calculator" },
		content: "canvas-app",
		replaces: false,
		patch: { title: "Weekend plan" },
	},
	{
		kind: "photo",
		data: {
			kind: "photo",
			items: [{ id: "a1", imageUrl: "/api/connections/immich/thumbnail/a1" }],
		},
		content: "canvas-photo",
		replaces: false,
		patch: { label: "Weekend plan" },
	},
];

function mount(entry: Case, selected = true) {
	return render(WithChat, {
		props: {
			component: LazyNode,
			componentProps: {
				id: `${entry.kind}-node`,
				type: entry.kind,
				selected,
				data: entry.data,
			},
			context: board(),
			chat: { conversationId: "conv-1" },
		},
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	uiLanguage.set("en");
});

describe.each(CASES)("a $kind block", (entry) => {
	it("opens its form from the toolbar's Edit, in place of the content or over it, and Cancel writes nothing", async () => {
		mount(entry);
		await screen.findByTestId(entry.content);
		expect(screen.queryByTestId("canvas-edit-form")).toBeNull();

		await fireEvent.click(screen.getByTestId("canvas-node-edit"));
		expect(await screen.findByTestId("canvas-edit-form")).toBeInTheDocument();
		if (entry.replaces) {
			expect(screen.queryByTestId(entry.content)).toBeNull();
			expect(screen.getByTestId("canvas-edit-source")).toBeInTheDocument();
		} else {
			expect(screen.getByTestId(entry.content)).toBeInTheDocument();
			expect(screen.queryByTestId("canvas-edit-source")).toBeNull();
		}

		await fireEvent.click(screen.getByTestId("canvas-edit-cancel"));
		expect(screen.queryByTestId("canvas-edit-form")).toBeNull();
		expect(await screen.findByTestId(entry.content)).toBeInTheDocument();
		expect(flowSpies.updateNodeData).not.toHaveBeenCalled();
	});

	it("saves a new title as one change to the block's data, and draws its content again", async () => {
		mount(entry);
		await screen.findByTestId(entry.content);
		await fireEvent.click(screen.getByTestId("canvas-node-edit"));
		await fireEvent.input(await screen.findByTestId("canvas-edit-title"), {
			target: { value: "Weekend plan" },
		});
		await fireEvent.click(screen.getByTestId("canvas-edit-save"));
		expect(flowSpies.updateNodeData).toHaveBeenCalledTimes(1);
		expect(flowSpies.updateNodeData).toHaveBeenCalledWith(
			`${entry.kind}-node`,
			entry.patch,
		);
		expect(screen.queryByTestId("canvas-edit-form")).toBeNull();
		expect(await screen.findByTestId(entry.content)).toBeInTheDocument();
	});

	it("opens its form on F2 from the keyboard, and gives the focus back to the block when it is left", async () => {
		mount(entry, false);
		await screen.findByTestId(entry.content);
		const wrapper = screen.getByTestId("node-wrapper");
		await fireEvent.keyDown(wrapper, { key: "F2" });
		const title = await screen.findByTestId("canvas-edit-title");
		await waitFor(() => expect(title).toHaveFocus());
		await fireEvent.keyDown(title, { key: "Escape" });
		expect(screen.queryByTestId("canvas-edit-form")).toBeNull();
		expect(wrapper).toHaveFocus();
	});
});

describe("a map block's title", () => {
	it("starts as the route the header shows, and an untouched title writes nothing", async () => {
		const entry = CASES.find((one) => one.kind === "map") as Case;
		mount(entry);
		await screen.findByTestId("canvas-map");
		await fireEvent.click(screen.getByTestId("canvas-node-edit"));
		expect(await screen.findByTestId("canvas-edit-title")).toHaveValue(
			"Cork → Kinsale",
		);
		await fireEvent.click(screen.getByTestId("canvas-edit-save"));
		expect(flowSpies.updateNodeData).not.toHaveBeenCalled();
	});
});

describe("a photo block", () => {
	it("says its caption in its header once it has one", async () => {
		const entry = CASES.find((one) => one.kind === "photo") as Case;
		mount({ ...entry, data: { ...entry.data, label: "Sunset at the lake" } });
		await screen.findByTestId("canvas-photo");
		expect(screen.getByText("Sunset at the lake")).toBeInTheDocument();
	});
});
