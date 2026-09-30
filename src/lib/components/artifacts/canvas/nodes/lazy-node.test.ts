import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import type { LazyNodeModule } from "../_lib/lazy-nodes";
import WithBoard from "../_test/WithBoard.svelte";
import LazyNode from "./LazyNode.svelte";

// The blocks made from the chat are loaded when one is on the board, not with
// the editor. `LazyNode` is what stands in the registry for them: it draws the
// block's shell at once and the block's content when its chunk arrives. What is
// measured here is the wrapper's own behaviour (the shell first, what it passes
// on, how the content dresses the shell, a way back from a failed load); which
// loader each kind has is `lazy-nodes.test.ts`'s, and what each block's content
// does is `chat-block-nodes.test.ts`'s.

vi.mock("@xyflow/svelte", async () =>
	(await import("../_test/xyflow-mock")).xyflowMock(),
);

const loaders: Record<string, () => Promise<LazyNodeModule>> = {};
vi.mock("../_lib/lazy-nodes", () => ({
	lazyNodeLoader: (kind: string) => loaders[kind] ?? null,
}));

const here = path.dirname(fileURLToPath(import.meta.url));

/** A content module that shows the props it was given and dresses the shell from the data. */
async function content(
	shell: LazyNodeModule["shell"] = (data: never) => ({
		title: `Title of ${(data as { name: string }).name}`,
		meta: "meta line",
		summary: `Summary of ${(data as { name: string }).name}`,
	}),
): Promise<LazyNodeModule> {
	return {
		default: (await import("../_test/StubContent.svelte"))
			.default as LazyNodeModule["default"],
		shell,
	};
}

function mount(props: Record<string, unknown>) {
	return render(WithBoard, {
		props: {
			component: LazyNode,
			componentProps: props,
			context: {
				readonly: false,
				requestEdit() {},
				takeEditRequest: () => false,
				dropTargetId: null,
			},
		},
	});
}

const nodeProps = (extra: Record<string, unknown> = {}) => ({
	id: "n1",
	type: "file",
	selected: false,
	data: { name: "trip.pdf" },
	...extra,
});

beforeEach(() => {
	vi.clearAllMocks();
	for (const key of Object.keys(loaders)) delete loaders[key];
	uiLanguage.set("en");
});

describe("the loading wrapper", () => {
	it("draws the block's shell at once, anchors and all, and its content when the chunk arrives", async () => {
		let arrive: (value: LazyNodeModule) => void = () => {};
		loaders.file = () => new Promise((resolve) => (arrive = resolve));
		mount(nodeProps());

		// A real node from the first frame: it can be moved, and an edge can attach.
		expect(screen.getByTestId("canvas-node").getAttribute("data-kind")).toBe(
			"file",
		);
		expect(screen.getAllByTestId("canvas-anchor")).toHaveLength(4);
		expect(screen.getByTestId("canvas-node-loading")).toBeInTheDocument();
		expect(screen.queryByTestId("content-stub")).toBeNull();

		arrive(await content());

		expect(await screen.findByTestId("content-stub")).toBeInTheDocument();
		expect(screen.queryByTestId("canvas-node-loading")).toBeNull();
		expect(screen.getAllByTestId("canvas-node")).toHaveLength(1);
	});

	it("hands the content the node's id, data and selection, and nothing else of the flow's", async () => {
		loaders.file = () => content();
		mount(
			nodeProps({ selected: true, width: 200, dragging: false, zIndex: 3 }),
		);
		const stub = await screen.findByTestId("content-stub");
		expect(JSON.parse(stub.dataset.propNames ?? "[]")).toEqual([
			"data",
			"id",
			"selected",
		]);
		expect(stub.dataset.nodeId).toBe("n1");
		expect(stub.dataset.selected).toBe("true");
		expect(JSON.parse(stub.dataset.data ?? "null")).toEqual({
			name: "trip.pdf",
		});
	});

	// A card draws a header (a title and a muted line); a file's row draws its own.
	it("lets the loaded content dress the shell: a title, a name for a screen reader, what Enter does", async () => {
		const activate = vi.fn();
		loaders.app = () =>
			content(() => ({
				title: "Trip",
				summary: "Trip App",
				meta: "2 KB",
				activate,
			}));
		mount(nodeProps({ type: "app" }));
		await screen.findByTestId("content-stub");

		expect(screen.getByText("Trip")).toBeInTheDocument();
		expect(screen.getByText("2 KB")).toBeInTheDocument();
		const wrapper = screen.getByTestId("node-wrapper");
		await waitFor(() =>
			expect(wrapper.getAttribute("aria-label")).toBe("App: Trip App"),
		);
		await fireEvent.keyDown(wrapper, { key: "Enter" });
		expect(activate).toHaveBeenCalledTimes(1);
	});

	it("names the shell after the kind alone until the content has said more", async () => {
		loaders.file = () => new Promise(() => {});
		mount(nodeProps());
		const wrapper = screen.getByTestId("node-wrapper");
		expect(wrapper.getAttribute("aria-label")).toBe("File");
	});

	it("follows the block: new data dresses the shell again", async () => {
		loaders.app = () => content();
		const view = mount(nodeProps({ type: "app" }));
		await screen.findByTestId("content-stub");
		expect(screen.getByText("Title of trip.pdf")).toBeInTheDocument();
		await view.rerender({
			componentProps: nodeProps({ type: "app", data: { name: "plan.docx" } }),
		});
		expect(await screen.findByText("Title of plan.docx")).toBeInTheDocument();
		expect(screen.queryByText("Title of trip.pdf")).toBeNull();
	});

	it("says the block could not load, in the shell, and tries again on request", async () => {
		const load = vi
			.fn()
			.mockRejectedValueOnce(new Error("chunk failed"))
			.mockResolvedValue(await content());
		loaders.file = load;
		mount(nodeProps());

		expect(
			await screen.findByText("This block could not load."),
		).toBeInTheDocument();
		expect(screen.getByTestId("canvas-node")).toBeInTheDocument();
		await fireEvent.click(screen.getByRole("button", { name: "Try again" }));

		expect(await screen.findByTestId("content-stub")).toBeInTheDocument();
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("says it in Hungarian in Hungarian", async () => {
		uiLanguage.set("hu");
		loaders.file = () => Promise.reject(new Error("no"));
		mount(nodeProps());
		expect(
			await screen.findByText("Ezt a blokkot nem sikerült betölteni."),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Újra" })).toBeInTheDocument();
	});

	it("draws the missing-kind card for a kind it has no loader for, and stays a real node", () => {
		const { container } = mount(nodeProps({ type: "hologram" }));
		expect(container.querySelector('[data-missing="true"]')).not.toBeNull();
	});
});

describe("the editor's first paint", () => {
	const read = (...parts: string[]) =>
		readFileSync(path.join(here, ...parts), "utf8");

	it("holds no static import of a block made from the chat, or of what they carry, so none of it is in the editor's chunk", () => {
		const registry = read("..", "_lib", "block-registry.ts");
		const wrapper = read("LazyNode.svelte");
		const loaderSource = read("..", "_lib", "lazy-nodes.ts");
		for (const name of [
			"ChartNode",
			"ChecklistNode",
			"FileNode",
			"AppNode",
			"MapNode",
			"PhotoNode",
			"LiveWebNode",
		]) {
			expect(registry, `${name} in the registry`).not.toMatch(
				new RegExp(`import\\s+\\w+\\s+from\\s+"[^"]*${name}`),
			);
			expect(wrapper, `${name} in the wrapper`).not.toMatch(
				new RegExp(`import\\s+\\w+\\s+from\\s+"[^"]*${name}`),
			);
			expect(loaderSource).toContain(`import("../nodes/${name}.svelte")`);
		}
		for (const heavy of [
			"AppFrame",
			"MapRouteCard",
			"FileTypeIcon",
			"ImageLightbox",
			"chat-blocks",
		]) {
			expect(registry, heavy).not.toContain(heavy);
			expect(wrapper, heavy).not.toContain(heavy);
		}
	});

	// A block module that imported the shell (or the flow library) would make the
	// bundler move the shell out of the editor's own chunk into one the editor and
	// the block share: the editor would pay more than the block saves.
	it("keeps the shell and the flow library out of every block module, which are loaded on demand", () => {
		for (const name of [
			"ChartNode",
			"ChecklistNode",
			"FileNode",
			"AppNode",
			"MapNode",
			"PhotoNode",
			"LiveWebNode",
		]) {
			const source = read(`${name}.svelte`);
			expect(source, name).not.toMatch(/from\s+"\.\.\/NodeShell\.svelte"/);
			expect(source, name).not.toMatch(/from\s+"@xyflow\//);
			expect(source, name).not.toMatch(
				/from\s+"\.\.\/_lib\/block-(meta|registry)"/,
			);
		}
	});
});
