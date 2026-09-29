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
	// rd/review-2-5.md:217-222: this region is now a plain, non-live
	// role="region" — DocumentBody.svelte's own shared announcer owns the
	// landing summary's actual announcement (see that component's own
	// "announce" tests); this component still shows the same text, just
	// never announces itself.
	it("shows the singular summary and 1 / 1 for one pending change", () => {
		render(ReviewBar, { pendingCount: 1, currentIndex: 0, ...callbacks() });
		expect(screen.getByRole("region")).toHaveTextContent(
			"Alfy changed 1 part.",
		);
		expect(screen.getByText("1 / 1")).toBeInTheDocument();
	});

	it("shows the plural summary and the current position for several", () => {
		render(ReviewBar, { pendingCount: 3, currentIndex: 1, ...callbacks() });
		expect(screen.getByRole("region")).toHaveTextContent(
			"Alfy changed 3 parts.",
		);
		expect(screen.getByText("2 / 3")).toBeInTheDocument();
	});

	// A `{count}` nested INSIDE a plural branch used to leave the raw ICU
	// template unresolved (`index.ts`'s own plural regex cannot match a
	// branch containing its own braces) — invisible to the two tests above
	// because `toHaveTextContent`'s substring match still found "Alfy changed
	// 3 parts." INSIDE the unresolved "{count, plural, ...}" text. Asserting
	// the exact, full text (not a substring) is what actually catches that.
	it("resolves the summary to exactly the expected sentence, with no leftover ICU template text", () => {
		render(ReviewBar, { pendingCount: 3, currentIndex: 1, ...callbacks() });
		// The icon beside it is also a `<span>` (`.review-bar-spark`) — this one
		// is the summary's own text span, the OTHER child of `.review-bar-msg`.
		const summary = screen
			.getByRole("region")
			.querySelector("span:not(.review-bar-spark)");
		expect(summary?.textContent?.trim()).toBe("Alfy changed 3 parts.");
		expect(summary?.textContent).not.toContain("plural");
		expect(summary?.textContent).not.toContain("{count");
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
