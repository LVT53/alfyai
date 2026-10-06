import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import EmptyState from "./EmptyState.svelte";

// The one empty state every kind's body draws (Slice 6 T6): the kind's line,
// and, when the panel supplies a replay, a quiet link beneath it.

afterEach(() => {
	cleanup();
	uiLanguage.set("en");
});

describe("EmptyState", () => {
	it("shows the line under the test id it is given", () => {
		render(EmptyState, {
			props: { line: "Empty board. Insert a block.", testId: "canvas-empty" },
		});

		expect(screen.getByTestId("canvas-empty")).toHaveTextContent(
			"Empty board. Insert a block.",
		);
	});

	it("shows no link when it is not given a replay", () => {
		render(EmptyState, { props: { line: "Empty.", testId: "app-empty" } });

		expect(screen.queryByRole("button")).toBeNull();
		expect(screen.queryByTestId("app-empty-replay")).toBeNull();
	});

	it("shows a link beneath the line that calls the replay once, with no argument", async () => {
		const onReplayTour = vi.fn();
		render(EmptyState, {
			props: { line: "Empty.", testId: "app-empty", onReplayTour },
		});

		const line = screen.getByTestId("app-empty");
		const link = screen.getByRole("button", { name: "Show it again" });
		expect(link).toBe(screen.getByTestId("app-empty-replay"));
		// Beneath, in document order: after the line, in the same block.
		expect(
			line.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();

		await fireEvent.click(link);

		expect(onReplayTour).toHaveBeenCalledTimes(1);
		expect(onReplayTour).toHaveBeenCalledWith();
	});

	it("is a button, so the keyboard reaches it and activates it", async () => {
		const onReplayTour = vi.fn();
		render(EmptyState, {
			props: { line: "Empty.", testId: "document-empty", onReplayTour },
		});

		const link = screen.getByTestId("document-empty-replay");
		expect(link.tagName).toBe("BUTTON");
		expect(link).toHaveAttribute("type", "button");
		link.focus();
		expect(link).toHaveFocus();
		await fireEvent.keyDown(link, { key: "Enter" });
		await fireEvent.click(link);
		expect(onReplayTour).toHaveBeenCalled();
	});

	it("says it in Hungarian when the page is Hungarian", () => {
		uiLanguage.set("hu");
		render(EmptyState, {
			props: {
				line: "Üres tábla.",
				testId: "canvas-empty",
				onReplayTour: vi.fn(),
			},
		});

		expect(screen.getByTestId("canvas-empty-replay")).toHaveTextContent(
			"Újra megnézem",
		);
	});
});
