import { render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture every Chart.js instantiation so we can assert the canvas + config path
// without a real WebGL/2d context. The dynamic `import("chart.js/auto")` inside
// the component resolves to this mock.
const constructed: Array<{ canvas: unknown; config: unknown }> = [];
const destroy = vi.fn();
// When true, the mocked Chart.js constructor throws — standing in for a runtime
// error on a valid `type` but a bad dataset shape.
let throwOnConstruct = false;

vi.mock("chart.js/auto", () => ({
	default: class {
		constructor(canvas: unknown, config: unknown) {
			if (throwOnConstruct) throw new Error("bad dataset shape");
			constructed.push({ canvas, config });
		}
		destroy = destroy;
	},
}));

import Chart from "./Chart.svelte";

describe("Chart", () => {
	beforeEach(() => {
		constructed.length = 0;
		destroy.mockClear();
		throwOnConstruct = false;
	});
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("renders a <canvas> and instantiates Chart.js with the parsed config", async () => {
		const config = {
			type: "bar",
			data: { labels: ["A", "B"], datasets: [{ label: "X", data: [1, 2] }] },
		};
		const { container } = render(Chart, {
			props: { code: JSON.stringify(config) },
		});

		const canvas = container.querySelector("canvas");
		expect(canvas).toBeTruthy();

		await waitFor(() => {
			expect(constructed).toHaveLength(1);
		});
		expect(constructed[0].canvas).toBe(canvas);
		expect(constructed[0].config).toEqual(config);
	});

	it("shows an error note + the raw source (and never instantiates Chart.js) on invalid JSON", async () => {
		const { container } = render(Chart, {
			props: { code: "{ not valid json" },
		});

		expect(container.querySelector("canvas")).toBeNull();
		expect(container.querySelector(".markdown-diagram-error")).toBeTruthy();
		const source = container.querySelector(".markdown-diagram-source");
		expect(source?.textContent).toContain("{ not valid json");

		// Give any (incorrect) async instantiation a chance to run, then assert none did.
		await Promise.resolve();
		expect(constructed).toHaveLength(0);
	});

	it("treats a config missing `type`/`data` as invalid (raw fallback, no chart)", async () => {
		const { container } = render(Chart, {
			props: { code: JSON.stringify({ data: { datasets: [] } }) },
		});

		expect(container.querySelector("canvas")).toBeNull();
		expect(container.querySelector(".markdown-diagram-error")).toBeTruthy();
		await Promise.resolve();
		expect(constructed).toHaveLength(0);
	});

	it("degrades an unsupported chart type (e.g. gantt) to the raw fallback, never a blank canvas", async () => {
		const { container } = render(Chart, {
			props: {
				code: JSON.stringify({
					type: "gantt",
					data: { labels: ["W1"], datasets: [{ label: "A", data: [[0, 1]] }] },
				}),
			},
		});

		// gantt is not a Chart.js controller: no canvas, show the source + note,
		// and never hand it to Chart.js (which would throw and blank the canvas).
		expect(container.querySelector("canvas")).toBeNull();
		expect(container.querySelector(".markdown-diagram-error")).toBeTruthy();
		expect(container.querySelector(".markdown-diagram-source")?.textContent).toContain(
			"gantt",
		);
		await Promise.resolve();
		expect(constructed).toHaveLength(0);
	});

	it("falls back to the source when Chart.js throws at runtime (no silent blank canvas)", async () => {
		throwOnConstruct = true;
		const { container } = render(Chart, {
			props: {
				code: JSON.stringify({
					type: "bar",
					data: { labels: ["A"], datasets: [{ label: "X", data: [1] }] },
				}),
			},
		});

		// The type is valid so a canvas mounts and Chart.js is attempted, but the
		// constructor throws — the component must surface the fallback, not a blank.
		await waitFor(() =>
			expect(container.querySelector(".markdown-diagram-error")).toBeTruthy(),
		);
		expect(container.querySelector("canvas")).toBeNull();
	});

	it("re-instantiates the chart when the config changes at the same index (unkeyed reconcile)", async () => {
		// MarkdownRenderer's block {#each} is unkeyed (index-reconciled): a chart
		// block whose JSON changes at the same index reuses THIS component instance,
		// so onMount never re-fires. The chart must still rebuild — destroy the old
		// Chart.js instance and instantiate a new one from the changed config.
		const bar = {
			type: "bar",
			data: { labels: ["A"], datasets: [{ label: "X", data: [1] }] },
		};
		const line = {
			type: "line",
			data: { labels: ["A"], datasets: [{ label: "X", data: [2] }] },
		};
		const { rerender } = render(Chart, {
			props: { code: JSON.stringify(bar) },
		});
		await waitFor(() => expect(constructed).toHaveLength(1));
		expect(constructed[0].config).toEqual(bar);

		await rerender({ code: JSON.stringify(line) });
		await waitFor(() => expect(constructed).toHaveLength(2));
		// The stale bar instance was torn down before the new one was built.
		expect(destroy).toHaveBeenCalled();
		expect(constructed[1].config).toEqual(line);
	});

	it("rebuilds from the raw-source fallback to a live chart when invalid JSON becomes valid", async () => {
		const valid = {
			type: "bar",
			data: { labels: ["A"], datasets: [{ label: "X", data: [1] }] },
		};
		const { container, rerender } = render(Chart, {
			props: { code: "{ not valid json" },
		});
		expect(container.querySelector("canvas")).toBeNull();
		await Promise.resolve();
		expect(constructed).toHaveLength(0);

		await rerender({ code: JSON.stringify(valid) });
		await waitFor(() => expect(container.querySelector("canvas")).toBeTruthy());
		await waitFor(() => expect(constructed).toHaveLength(1));
		expect(constructed[0].config).toEqual(valid);
		expect(container.querySelector(".markdown-diagram-error")).toBeNull();
	});

	it("destroys the Chart.js instance on unmount", async () => {
		const { unmount } = render(Chart, {
			props: {
				code: JSON.stringify({ type: "line", data: { datasets: [] } }),
			},
		});
		await waitFor(() => expect(constructed).toHaveLength(1));

		unmount();
		expect(destroy).toHaveBeenCalled();
	});
});
