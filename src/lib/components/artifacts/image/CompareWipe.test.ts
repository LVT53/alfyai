import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import CompareWipe from "./CompareWipe.svelte";

// History's compare wipe (plan 2b T4, preflight §4 T4): two pictures in one
// box, the newer laid over the older and cut at the wipe's position. The cut is
// a native range input (keyboard and touch come with it); the position is
// written to `clip-path` in an animation frame, never through a transition.

function renderWipe(position = 50, hasAlpha = false) {
	return render(CompareWipe, {
		hasAlpha,
		beforeUrl: "/api/images/files/file-1",
		afterUrl: "/api/images/files/file-2",
		width: 1248,
		height: 832,
		position,
		label: "Drag to compare",
	});
}

const top = () => screen.getByTestId("compare-wipe-after");
const range = () =>
	screen.getByRole("slider", { name: "Drag to compare" }) as HTMLInputElement;

describe("CompareWipe", () => {
	it("draws both pictures in the box the newer one reserves, cut at the middle", async () => {
		renderWipe();
		expect(screen.getByTestId("compare-wipe-before").getAttribute("src")).toBe(
			"/api/images/files/file-1",
		);
		expect(top().getAttribute("src")).toBe("/api/images/files/file-2");
		expect(screen.getByTestId("compare-wipe").style.aspectRatio).toBe(
			"1248 / 832",
		);
		expect(range().value).toBe("50");
		await waitFor(() => expect(top().style.clipPath).toBe("inset(0 0 0 50%)"));
	});

	it("cuts the top picture where the range is moved, in a frame, with no transition on the cut", async () => {
		renderWipe();
		await fireEvent.input(range(), { target: { value: "30" } });
		await waitFor(() => expect(top().style.clipPath).toBe("inset(0 0 0 30%)"));
		expect(top().style.transition).toBe("");
		expect(screen.getByTestId("compare-wipe-line").style.transform).toContain(
			"30",
		);
	});

	it("moves with the keyboard: the arrows step it, Home and End go to the ends", async () => {
		renderWipe(50);
		await fireEvent.keyDown(range(), { key: "ArrowLeft" });
		await waitFor(() => expect(Number(range().value)).toBeLessThan(50));
		await fireEvent.keyDown(range(), { key: "Home" });
		await waitFor(() => expect(top().style.clipPath).toBe("inset(0 0 0 0%)"));
		await fireEvent.keyDown(range(), { key: "End" });
		await waitFor(() => expect(top().style.clipPath).toBe("inset(0 0 0 100%)"));
	});

	it("says where it stands to a screen reader", () => {
		renderWipe(30);
		expect(range().getAttribute("aria-valuetext")).toBe("30%");
	});

	it("clips the older picture to its own side of the cut, so a see-through newer one never shows it", async () => {
		renderWipe(50);
		await fireEvent.input(range(), { target: { value: "30" } });
		await waitFor(() =>
			expect(screen.getByTestId("compare-wipe-under").style.clipPath).toBe(
				"inset(0 70% 0 0)",
			),
		);
		expect(top().style.clipPath).toBe("inset(0 0 0 30%)");
		expect(screen.getByTestId("compare-wipe-under").style.transition).toBe("");
		// The older picture and its marks are inside the clipped side.
		expect(
			screen
				.getByTestId("compare-wipe-under")
				.contains(screen.getByTestId("compare-wipe-before")),
		).toBe(true);
	});

	it("draws the checkerboard behind both pictures when one is see-through", () => {
		renderWipe(50, true);
		expect(
			screen
				.getByTestId("compare-wipe")
				.classList.contains("image-checkerboard"),
		).toBe(true);
	});

	it("draws no checkerboard for two opaque pictures", () => {
		renderWipe(50, false);
		expect(
			screen
				.getByTestId("compare-wipe")
				.classList.contains("image-checkerboard"),
		).toBe(false);
	});
});
