import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import CanvasBanners from "./CanvasBanners.svelte";

// The notice for a step of the reader's that was put on top of a newer version of the
// board, the reader's version standing where both had changed the same thing (RV-3 I2).

const shared = {
	banner: null,
	droppedCount: 0,
	onretry: vi.fn(),
	onreload: vi.fn(),
	ondismiss: vi.fn(),
};

describe("CanvasBanners · the kept notice", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		uiLanguage.set("en");
	});

	it("says how many blocks kept the reader's version, as a status with a Dismiss button", async () => {
		const ondismisskept = vi.fn();
		render(CanvasBanners, { ...shared, keptCount: 2, ondismisskept });

		const notice = screen.getByTestId("canvas-rebased-notice");
		expect(notice).toHaveAttribute("role", "status");
		expect(notice).toHaveTextContent(
			"Alfy changed 2 blocks you had also changed. Your version was kept.",
		);
		await fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(ondismisskept).toHaveBeenCalledTimes(1);
		// It is the notice's own Dismiss: the one for blocks left out is not called.
		expect(shared.ondismiss).not.toHaveBeenCalled();
	});

	it("says it for one block in the singular", () => {
		render(CanvasBanners, { ...shared, keptCount: 1 });
		expect(screen.getByTestId("canvas-rebased-notice")).toHaveTextContent(
			"Alfy changed 1 block you had also changed.",
		);
	});

	it("says it in Hungarian", () => {
		uiLanguage.set("hu");
		render(CanvasBanners, { ...shared, keptCount: 3 });
		expect(screen.getByTestId("canvas-rebased-notice")).toHaveTextContent(
			"Alfy 3 olyan blokkot módosított, amelyen te is változtattál. A te változatod maradt meg.",
		);
		expect(
			screen.getByRole("button", { name: "Elrejtés" }),
		).toBeInTheDocument();
	});

	it("shows nothing when no block was kept, and leaves the saving notices alone", () => {
		render(CanvasBanners, { ...shared, keptCount: 0, banner: "conflict" });
		expect(screen.queryByTestId("canvas-rebased-notice")).toBeNull();
		expect(screen.getByTestId("canvas-conflict")).toBeInTheDocument();
	});
});
