import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import ReviewBar from "./ReviewBar.svelte";

afterEach(() => {
	cleanup();
});

function callbacks() {
	return {
		onPrev: vi.fn(),
		onNext: vi.fn(),
		onKeepAll: vi.fn(),
		onUndoAll: vi.fn(),
	};
}

describe("ReviewBar", () => {
	it("shows the singular summary and 1 / 1 for one pending change", () => {
		render(ReviewBar, { pendingCount: 1, currentIndex: 0, ...callbacks() });
		expect(screen.getByRole("status")).toHaveTextContent(
			"Alfy changed 1 part.",
		);
		expect(screen.getByText("1 / 1")).toBeInTheDocument();
	});

	it("shows the plural summary and the current position for several", () => {
		render(ReviewBar, { pendingCount: 3, currentIndex: 1, ...callbacks() });
		expect(screen.getByRole("status")).toHaveTextContent(
			"Alfy changed 3 parts.",
		);
		expect(screen.getByText("2 / 3")).toBeInTheDocument();
	});

	it("disables prev/next with only one pending change", () => {
		render(ReviewBar, { pendingCount: 1, currentIndex: 0, ...callbacks() });
		expect(
			screen.getByRole("button", { name: "Previous change" }),
		).toBeDisabled();
		expect(screen.getByRole("button", { name: "Next change" })).toBeDisabled();
	});

	it("calls onPrev/onNext when the stepper is clicked with several pending", async () => {
		const onPrev = vi.fn();
		const onNext = vi.fn();
		render(ReviewBar, {
			pendingCount: 2,
			currentIndex: 0,
			...callbacks(),
			onPrev,
			onNext,
		});
		await fireEvent.click(
			screen.getByRole("button", { name: "Previous change" }),
		);
		await fireEvent.click(screen.getByRole("button", { name: "Next change" }));
		expect(onPrev).toHaveBeenCalledOnce();
		expect(onNext).toHaveBeenCalledOnce();
	});

	it("calls onKeepAll and onUndoAll", async () => {
		const onKeepAll = vi.fn();
		const onUndoAll = vi.fn();
		render(ReviewBar, {
			pendingCount: 2,
			currentIndex: 0,
			...callbacks(),
			onKeepAll,
			onUndoAll,
		});
		await fireEvent.click(screen.getByRole("button", { name: /Keep all/ }));
		await fireEvent.click(screen.getByRole("button", { name: /Undo all/ }));
		expect(onKeepAll).toHaveBeenCalledOnce();
		expect(onUndoAll).toHaveBeenCalledOnce();
	});

	it("shows no refusal link when nothing was refused", () => {
		render(ReviewBar, { pendingCount: 1, currentIndex: 0, ...callbacks() });
		expect(screen.queryByText(/Left \d+ alone/)).not.toBeInTheDocument();
	});

	it("shows the refusal link and calls onSeeRefused when it is clicked", async () => {
		const onSeeRefused = vi.fn();
		render(ReviewBar, {
			pendingCount: 1,
			refusedCount: 2,
			currentIndex: 0,
			...callbacks(),
			onSeeRefused,
		});
		const link = screen.getByRole("button", { name: "Left 2 alone." });
		expect(link).toBeInTheDocument();
		await fireEvent.click(link);
		expect(onSeeRefused).toHaveBeenCalledOnce();
	});
});
