import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasBlockData } from "$lib/shared/artifacts/canvas-blocks";
import { uiLanguage } from "$lib/stores/settings";
import type { EditedKind } from "../_lib/block-edit";
import type { CanvasBoardContext } from "../_lib/board-context";
import WithBoard from "../_test/WithBoard.svelte";
import BlockEditForm from "./BlockEditForm.svelte";

// The smallest editor a block can have: a title, and for a chart and a diagram its own
// source, in a form that takes the block's place. Nothing is written until Save, Save is
// one write for what changed, the block's schema judges a source, and Cancel and Escape
// leave the block as it was.

const BAR = JSON.stringify({
	type: "bar",
	data: { labels: ["A", "B"], datasets: [{ data: [1, 2] }] },
});

const updateData = vi.fn();
const onclose = vi.fn();

function context(): CanvasBoardContext {
	return {
		readonly: false,
		requestEdit() {},
		takeEditRequest: () => false,
		dropTargetId: null,
		updateData: (id, patch) => updateData(id, patch),
	};
}

function mount(kind: EditedKind, data: CanvasBlockData, overlay = false) {
	return render(WithBoard, {
		props: {
			component: BlockEditForm,
			componentProps: { id: "block-1", kind, data, onclose, overlay },
			context: context(),
		},
	});
}

const chart = (extra: Record<string, unknown> = {}) =>
	({ kind: "chart", code: BAR, ...extra }) as CanvasBlockData;

beforeEach(() => {
	vi.clearAllMocks();
	uiLanguage.set("en");
});

describe("the form of a chart", () => {
	it("starts with the block's title and its source laid out over lines, and writes nothing when nothing changed", async () => {
		mount("chart", chart({ label: "Sales" }));
		expect(screen.getByRole("form", { name: "Edit" })).toBeInTheDocument();
		expect(screen.getByTestId("canvas-edit-title")).toHaveValue("Sales");
		const source = screen.getByTestId(
			"canvas-edit-source",
		) as HTMLTextAreaElement;
		expect(source.value.split("\n").length).toBeGreaterThan(5);
		expect(JSON.parse(source.value)).toEqual(JSON.parse(BAR));
		expect(screen.queryByTestId("canvas-edit-error")).toBeNull();

		await fireEvent.click(screen.getByTestId("canvas-edit-save"));
		expect(updateData).not.toHaveBeenCalled();
		expect(onclose).toHaveBeenCalledTimes(1);
	});

	it("takes the focus into the title when it opens", async () => {
		mount("chart", chart());
		await waitFor(() =>
			expect(screen.getByTestId("canvas-edit-title")).toHaveFocus(),
		);
	});

	it("saves a changed title and a changed source as ONE write, the source back on the board's one line", async () => {
		mount("chart", chart());
		await fireEvent.input(screen.getByTestId("canvas-edit-title"), {
			target: { value: "  Visits per day " },
		});
		const next = {
			type: "line",
			data: { labels: ["Mon"], datasets: [{ data: [3] }] },
		};
		await fireEvent.input(screen.getByTestId("canvas-edit-source"), {
			target: { value: JSON.stringify(next, null, 4) },
		});
		await fireEvent.click(screen.getByTestId("canvas-edit-save"));
		expect(updateData).toHaveBeenCalledTimes(1);
		expect(updateData).toHaveBeenCalledWith("block-1", {
			label: "Visits per day",
			code: JSON.stringify(next),
		});
		expect(onclose).toHaveBeenCalledTimes(1);
	});

	it("says why a source cannot be saved, and does not save it, until it can", async () => {
		mount("chart", chart());
		const source = screen.getByTestId("canvas-edit-source");
		const save = screen.getByTestId("canvas-edit-save");

		await fireEvent.input(source, { target: { value: "{ not a chart" } });
		expect(screen.getByTestId("canvas-edit-error")).toHaveTextContent(
			"This is not a chart yet",
		);
		expect(screen.getByTestId("canvas-edit-error")).toHaveAttribute(
			"role",
			"alert",
		);
		expect(source).toHaveAttribute("aria-invalid", "true");
		expect(save).toBeDisabled();
		await fireEvent.keyDown(source, { key: "Enter", ctrlKey: true });
		expect(updateData).not.toHaveBeenCalled();

		await fireEvent.input(source, { target: { value: "   " } });
		expect(screen.getByTestId("canvas-edit-error")).toHaveTextContent(
			"This cannot be empty.",
		);

		await fireEvent.input(source, { target: { value: "x".repeat(100_001) } });
		expect(screen.getByTestId("canvas-edit-error")).toHaveTextContent(
			"longer than a board can keep",
		);

		await fireEvent.input(source, { target: { value: BAR } });
		expect(screen.queryByTestId("canvas-edit-error")).toBeNull();
		expect(save).toBeEnabled();
	});

	it("is a Ctrl or Cmd plus Enter to save, and Escape or Cancel to leave everything as it was", async () => {
		mount("chart", chart());
		await fireEvent.input(screen.getByTestId("canvas-edit-title"), {
			target: { value: "Changed" },
		});
		await fireEvent.keyDown(screen.getByTestId("canvas-edit-title"), {
			key: "Escape",
		});
		expect(updateData).not.toHaveBeenCalled();
		expect(onclose).toHaveBeenCalledTimes(1);

		await fireEvent.click(screen.getByTestId("canvas-edit-cancel"));
		expect(updateData).not.toHaveBeenCalled();
		expect(onclose).toHaveBeenCalledTimes(2);

		await fireEvent.keyDown(screen.getByTestId("canvas-edit-title"), {
			key: "Enter",
			metaKey: true,
		});
		expect(updateData).toHaveBeenCalledWith("block-1", { label: "Changed" });
	});

	it("carries the class that lifts its block above the ones beside it, and the rule that does", () => {
		mount("chart", chart());
		expect(screen.getByTestId("canvas-edit-form").className).toContain(
			"canvas-edit-form",
		);
		const source = readFileSync(
			path.join(
				path.dirname(fileURLToPath(import.meta.url)),
				"BlockEditForm.svelte",
			),
			"utf8",
		);
		expect(source).toMatch(
			/:global\(\.svelte-flow__node:has\(\.canvas-edit-form\)\)\s*\{[^}]*z-index:\s*12\s*!important/,
		);
	});

	it("keeps Escape and Ctrl+Enter to itself: the panel around the board does not hear them", async () => {
		const outside = vi.fn();
		document.addEventListener("keydown", outside);
		mount("chart", chart());
		await fireEvent.keyDown(screen.getByTestId("canvas-edit-source"), {
			key: "Escape",
		});
		await fireEvent.keyDown(screen.getByTestId("canvas-edit-source"), {
			key: "Enter",
			ctrlKey: true,
		});
		document.removeEventListener("keydown", outside);
		expect(outside).not.toHaveBeenCalled();
	});
});

describe("the form of a diagram", () => {
	it("holds the Mermaid source as it is, and any text can be saved: Mermaid is the judge of its syntax", async () => {
		mount("mermaid", { kind: "mermaid", code: "flowchart TD\n  A --> B" });
		const source = screen.getByTestId(
			"canvas-edit-source",
		) as HTMLTextAreaElement;
		expect(source.value).toBe("flowchart TD\n  A --> B");
		expect(screen.getByText("Diagram source (Mermaid)")).toBeInTheDocument();
		await fireEvent.input(source, { target: { value: "not mermaid at all" } });
		expect(screen.queryByTestId("canvas-edit-error")).toBeNull();
		await fireEvent.click(screen.getByTestId("canvas-edit-save"));
		expect(updateData).toHaveBeenCalledWith("block-1", {
			code: "not mermaid at all",
		});
	});
});

describe("the form of a block with only a title", () => {
	it("has no source field and writes the title where the kind keeps it", async () => {
		mount("checklist", { kind: "checklist", items: [] }, true);
		expect(screen.queryByTestId("canvas-edit-source")).toBeNull();
		await fireEvent.input(screen.getByTestId("canvas-edit-title"), {
			target: { value: "Packing" },
		});
		await fireEvent.click(screen.getByTestId("canvas-edit-save"));
		expect(updateData).toHaveBeenCalledWith("block-1", { label: "Packing" });
	});

	it("writes an App's title as `title`, and clears it to an empty one", async () => {
		mount("app", { kind: "app", artifactId: "a", title: "Tips" }, true);
		expect(screen.getByTestId("canvas-edit-title")).toHaveValue("Tips");
		await fireEvent.input(screen.getByTestId("canvas-edit-title"), {
			target: { value: "" },
		});
		await fireEvent.click(screen.getByTestId("canvas-edit-save"));
		expect(updateData).toHaveBeenCalledWith("block-1", { title: "" });
	});

	it("lies over the block's content when asked to, and takes its place when not", () => {
		const { unmount } = mount("photo", { kind: "photo", items: [] }, true);
		expect(screen.getByTestId("canvas-edit-form").className).toContain(
			"edit--overlay",
		);
		unmount();
		mount("chart", chart());
		expect(screen.getByTestId("canvas-edit-form").className).not.toContain(
			"edit--overlay",
		);
	});
});

describe("in Hungarian", () => {
	it("says the labels and the problems in Hungarian", async () => {
		uiLanguage.set("hu");
		mount("chart", chart());
		expect(
			screen.getByRole("form", { name: "Szerkesztés" }),
		).toBeInTheDocument();
		expect(screen.getByText("Cím")).toBeInTheDocument();
		expect(screen.getByText("Diagram adatai (JSON)")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Mégse" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Mentés" })).toBeInTheDocument();
		await fireEvent.input(screen.getByTestId("canvas-edit-source"), {
			target: { value: "" },
		});
		expect(screen.getByTestId("canvas-edit-error")).toHaveTextContent(
			"Ez nem maradhat üresen.",
		);
	});
});

// CV-B2: on a phone the form is the app's bottom sheet, like the board's other phone
// surfaces. In the block it was drawn at the board's zoom (a few pixels tall on a
// zoomed-out board), and a block low in the pane left its buttons below the fold. The
// sheet is at its own size, whatever the board does, and its buttons are pinned.
describe("on a phone", () => {
	const width = Object.getOwnPropertyDescriptor(window, "innerWidth");

	function setWidth(value: number) {
		Object.defineProperty(window, "innerWidth", {
			value,
			configurable: true,
			writable: true,
		});
	}

	beforeEach(() => setWidth(390));
	afterEach(() => {
		if (width) Object.defineProperty(window, "innerWidth", width);
		else setWidth(1024);
	});

	it("is a sheet over the page, and nothing of the form is left in the block", async () => {
		const { container } = mount("chart", chart({ label: "Sales" }));
		const dialog = await screen.findByRole("dialog", { name: "Edit" });
		expect(dialog.closest("[data-presentation]")).toHaveAttribute(
			"data-presentation",
			"sheet",
		);
		expect(within(dialog).getByTestId("canvas-edit-form")).toBeInTheDocument();
		expect(within(dialog).getByTestId("canvas-edit-title")).toHaveValue(
			"Sales",
		);
		expect(container.querySelector("form")).toBeNull();
		expect(screen.getAllByRole("form", { name: "Edit" })).toHaveLength(1);
	});

	it("pins Save and Cancel in the sheet's footer, Cancel first, outside what scrolls", async () => {
		mount("chart", chart());
		const footer = await screen.findByTestId("dialog-shell-footer");
		const buttons = within(footer).getAllByRole("button");
		expect(buttons.map((button) => button.textContent?.trim())).toEqual([
			"Cancel",
			"Save",
		]);
		expect(footer.contains(screen.getByTestId("canvas-edit-source"))).toBe(
			false,
		);
		expect(screen.getByTestId("canvas-edit-save")).toBe(buttons[1]);
		expect(screen.getByTestId("canvas-edit-cancel")).toBe(buttons[0]);
	});

	it("saves with the footer's Save as ONE write, though the button is outside the form, and Enter in the title saves too", async () => {
		mount("chart", chart());
		await fireEvent.input(await screen.findByTestId("canvas-edit-title"), {
			target: { value: "Visits" },
		});
		await fireEvent.click(screen.getByTestId("canvas-edit-save"));
		expect(updateData).toHaveBeenCalledTimes(1);
		expect(updateData).toHaveBeenCalledWith("block-1", { label: "Visits" });
		expect(onclose).toHaveBeenCalledTimes(1);

		updateData.mockClear();
		await fireEvent.input(screen.getByTestId("canvas-edit-title"), {
			target: { value: "Visits 2" },
		});
		await fireEvent.submit(screen.getByTestId("canvas-edit-form"));
		expect(updateData).toHaveBeenCalledWith("block-1", { label: "Visits 2" });
	});

	it("does not save a source its block would refuse, and says why in the sheet", async () => {
		mount("chart", chart());
		await fireEvent.input(await screen.findByTestId("canvas-edit-source"), {
			target: { value: "{ not a chart" },
		});
		expect(screen.getByTestId("canvas-edit-error")).toHaveTextContent(
			"This is not a chart yet",
		);
		expect(screen.getByTestId("canvas-edit-save")).toBeDisabled();
		await fireEvent.click(screen.getByTestId("canvas-edit-save"));
		expect(updateData).not.toHaveBeenCalled();
	});

	it("writes nothing on Cancel, on Escape and on a tap on the page behind it", async () => {
		mount("chart", chart());
		await fireEvent.input(await screen.findByTestId("canvas-edit-title"), {
			target: { value: "Changed" },
		});
		await fireEvent.click(screen.getByTestId("canvas-edit-cancel"));
		expect(onclose).toHaveBeenCalledTimes(1);
		await fireEvent.keyDown(screen.getByTestId("canvas-edit-title"), {
			key: "Escape",
		});
		expect(onclose).toHaveBeenCalledTimes(2);
		// The sheet's scrim is the button that closes the dialog when the page behind it is tapped.
		const scrim = document.querySelector(".dialog-sheet__scrim");
		expect(scrim).not.toBeNull();
		await fireEvent.click(scrim as Element);
		expect(onclose).toHaveBeenCalledTimes(3);
		expect(updateData).not.toHaveBeenCalled();
	});

	it("does not take the focus into the title: the keyboard it opens would cover the sheet", async () => {
		mount("chart", chart());
		const title = await screen.findByTestId("canvas-edit-title");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(title).not.toHaveFocus();
	});

	it("gives the page back its form where the window is wide: the draft is kept", async () => {
		const { container } = mount("chart", chart());
		await fireEvent.input(await screen.findByTestId("canvas-edit-title"), {
			target: { value: "Half typed" },
		});
		setWidth(1280);
		window.dispatchEvent(new Event("resize"));
		await waitFor(() => expect(container.querySelector("form")).not.toBeNull());
		// (The sheet slides away on its own motion, which jsdom does not run: the e2e spec
		// watches it go.)
		expect(within(container).getByTestId("canvas-edit-title")).toHaveValue(
			"Half typed",
		);
	});

	it("says it in Hungarian in Hungarian", async () => {
		uiLanguage.set("hu");
		mount("chart", chart());
		expect(
			await screen.findByRole("dialog", { name: "Szerkesztés" }),
		).toBeInTheDocument();
		const footer = screen.getByTestId("dialog-shell-footer");
		expect(
			within(footer).getByRole("button", { name: "Mentés" }),
		).toBeInTheDocument();
		expect(
			within(footer).getByRole("button", { name: "Mégse" }),
		).toBeInTheDocument();
	});
});
