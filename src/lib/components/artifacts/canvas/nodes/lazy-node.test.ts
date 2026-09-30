import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import type { Component } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import WithBoard from "../_test/WithBoard.svelte";
import LazyNode from "./LazyNode.svelte";

// The blocks made from the chat are loaded when one is on the board, not with
// the editor: `LazyNode` is what stands in the registry for them. What is
// measured here is the wrapper's own behaviour (a stand-in while it loads, every
// prop passed on, a way back from a failed load); which loader each kind has is
// `lazy-nodes.test.ts`'s.

vi.mock("@xyflow/svelte", async () =>
	(await import("../_test/xyflow-mock")).xyflowMock(),
);

const loaders: Record<string, () => Promise<{ default: Component<never> }>> =
	{};
vi.mock("../_lib/lazy-nodes", () => ({
	lazyNodeLoader: (kind: string) => loaders[kind] ?? null,
}));

const here = path.dirname(fileURLToPath(import.meta.url));

/** A node component that shows the props it was given. */
async function probe() {
	return (await import("../_test/StubChart.svelte"))
		.default as Component<never>;
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

beforeEach(() => {
	vi.clearAllMocks();
	for (const key of Object.keys(loaders)) delete loaders[key];
	uiLanguage.set("en");
});

describe("the loading wrapper", () => {
	it("stands in for the block while its code loads, then draws the block itself", async () => {
		let arrive: (value: { default: Component<never> }) => void = () => {};
		loaders.file = () => new Promise((resolve) => (arrive = resolve));
		mount({ id: "n1", type: "file", selected: false, data: { code: "x" } });

		expect(screen.getByTestId("canvas-node-loading")).toBeInTheDocument();
		expect(screen.queryByTestId("chart-stub")).toBeNull();

		arrive({ default: await probe() });

		expect(await screen.findByTestId("chart-stub")).toBeInTheDocument();
		expect(screen.queryByTestId("canvas-node-loading")).toBeNull();
	});

	it("passes every prop the flow gave the node on to the block, untouched", async () => {
		loaders.file = async () => ({ default: await probe() });
		// The probe reads its own `code` prop; the flow's props are `id`, `type`,
		// `selected` and the rest, and all of them must arrive.
		mount({ id: "n1", type: "file", selected: true, code: "the code" });
		const stub = await screen.findByTestId("chart-stub");
		expect(stub.dataset.code).toBe("the code");
		expect(JSON.parse(stub.dataset.propNames ?? "[]")).toEqual([
			"code",
			"id",
			"selected",
			"type",
		]);
	});

	it("does not load a block's code twice for two blocks of one kind", async () => {
		const load = vi.fn(async () => ({ default: await probe() }));
		loaders.file = load;
		mount({ id: "n1", type: "file", selected: false, data: { code: "a" } });
		mount({ id: "n2", type: "file", selected: false, data: { code: "b" } });
		await waitFor(() =>
			expect(screen.getAllByTestId("chart-stub")).toHaveLength(2),
		);
		// The browser caches a dynamic import; each wrapper still asks once.
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("says the block could not load, and tries again on request", async () => {
		const load = vi
			.fn()
			.mockRejectedValueOnce(new Error("chunk failed"))
			.mockResolvedValue({ default: await probe() });
		loaders.file = load;
		mount({ id: "n1", type: "file", selected: false, data: { code: "x" } });

		expect(
			await screen.findByText("This block could not load."),
		).toBeInTheDocument();
		await fireEvent.click(screen.getByRole("button", { name: "Try again" }));

		expect(await screen.findByTestId("chart-stub")).toBeInTheDocument();
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("says it in Hungarian in Hungarian", async () => {
		uiLanguage.set("hu");
		loaders.file = () => Promise.reject(new Error("no"));
		mount({ id: "n1", type: "file", selected: false, data: {} });
		expect(
			await screen.findByText("Ezt a blokkot nem sikerült betölteni."),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Újra" })).toBeInTheDocument();
	});

	it("draws the missing-kind card for a kind it has no loader for, and stays a real node", () => {
		const { container } = mount({
			id: "n1",
			type: "photo",
			selected: false,
			data: {},
		});
		expect(container.querySelector('[data-missing="true"]')).not.toBeNull();
	});

	it("keeps a stand-in that is not a node: a count of nodes is a count of drawn blocks", () => {
		loaders.file = () => new Promise(() => {});
		mount({ id: "n1", type: "file", selected: false, data: {} });
		expect(screen.queryByTestId("canvas-node")).toBeNull();
		expect(screen.getByTestId("canvas-node-loading")).toBeInTheDocument();
	});
});

describe("the editor's first paint", () => {
	it("holds no static import of a block made from the chat (or of what they carry), so none of it is in the editor's chunk", () => {
		const registry = readFileSync(
			path.join(here, "..", "_lib", "block-registry.ts"),
			"utf8",
		);
		const wrapper = readFileSync(path.join(here, "LazyNode.svelte"), "utf8");
		const loaders = readFileSync(
			path.join(here, "..", "_lib", "lazy-nodes.ts"),
			"utf8",
		);
		for (const name of ["FileNode", "AppNode", "MapNode"]) {
			expect(registry, `${name} in the registry`).not.toMatch(
				new RegExp(`import\\s+\\w+\\s+from\\s+"[^"]*${name}`),
			);
			expect(wrapper, `${name} in the wrapper`).not.toMatch(
				new RegExp(`import\\s+\\w+\\s+from\\s+"[^"]*${name}`),
			);
			expect(loaders).toContain(`import("../nodes/${name}.svelte")`);
		}
		for (const heavy of [
			"AppFrame",
			"MapRouteCard",
			"FileTypeIcon",
			"chat-blocks",
		]) {
			expect(registry, heavy).not.toContain(heavy);
			expect(wrapper, heavy).not.toContain(heavy);
		}
	});
});
