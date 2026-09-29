import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import SelectionBubble from "./SelectionBubble.svelte";

/**
 * `$lib/utils/viewport.svelte.ts`'s own `isPhoneViewport`/`watchPhoneViewport`
 * bucket on `window.innerWidth` (phone: < 640px), never `matchMedia` — this
 * stubs the actual signal they read, restored after every test.
 */
function stubViewport(isPhone: boolean): void {
	Object.defineProperty(window, "innerWidth", {
		writable: true,
		configurable: true,
		value: isPhone ? 390 : 1440,
	});
}

const ORIGINAL_INNER_WIDTH = window.innerWidth;

describe("SelectionBubble", () => {
	afterEach(() => {
		cleanup();
		Object.defineProperty(window, "innerWidth", {
			writable: true,
			configurable: true,
			value: ORIGINAL_INNER_WIDTH,
		});
	});

	it("shows Ask Alfy and Comment when a selection is active", () => {
		stubViewport(false);
		render(SelectionBubble, {
			position: { x: 10, y: 20 },
			quote: "Two adults; museums in the morning.",
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});
		expect(
			screen.getByRole("button", { name: "Ask Alfy" }),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Comment" })).toBeInTheDocument();
	});

	it("the pill is a toolbar named Selection", () => {
		stubViewport(false);
		render(SelectionBubble, {
			position: { x: 10, y: 20 },
			quote: "Hello",
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});
		expect(
			screen.getByRole("toolbar", { name: "Selection" }),
		).toBeInTheDocument();
	});

	// Review 2.5 (rd/review-2-5.md:198-207): the pill itself was unreachable
	// by keyboard at all (covered by `document-editor.test.ts`'s own Tab
	// interception test, since that half is a ProseMirror concern this
	// Tiptap-free component has no part in) — this covers what happens once
	// focus IS inside it: arrow keys rove between its own buttons instead of
	// leaving the browser to Tab through them one at a time.
	it("ArrowRight/ArrowLeft rove focus between the toolbar's own buttons, wrapping both ways", async () => {
		stubViewport(false);
		render(SelectionBubble, {
			position: { x: 10, y: 20 },
			quote: "Hello",
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});
		const askButton = screen.getByRole("button", { name: "Ask Alfy" });
		const commentButton = screen.getByRole("button", { name: "Comment" });
		askButton.focus();
		expect(askButton).toHaveFocus();

		await fireEvent.keyDown(askButton, { key: "ArrowRight" });
		expect(commentButton).toHaveFocus();

		// Wraps past the last button back to the first.
		await fireEvent.keyDown(commentButton, { key: "ArrowRight" });
		expect(askButton).toHaveFocus();

		// Wraps the other way past the first button back to the last.
		await fireEvent.keyDown(askButton, { key: "ArrowLeft" });
		expect(commentButton).toHaveFocus();
	});

	it("the same roving focus works in the phone docked bar", async () => {
		stubViewport(true);
		render(SelectionBubble, {
			position: { x: 10, y: 20 },
			quote: "Hello",
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});
		const askButton = screen.getByRole("button", { name: "Ask Alfy" });
		const commentButton = screen.getByRole("button", { name: "Comment" });
		askButton.focus();

		await fireEvent.keyDown(askButton, { key: "ArrowRight" });
		expect(commentButton).toHaveFocus();
	});

	it("Comment opens an empty composer with the mention hint, no @Alfy prefill", async () => {
		stubViewport(false);
		render(SelectionBubble, {
			position: { x: 0, y: 0 },
			quote: "Book the flight",
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});
		await fireEvent.click(screen.getByRole("button", { name: "Comment" }));
		const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;
		expect(textbox.value).toBe("");
		expect(
			screen.getByText("Mention @Alfy to get an answer and an edit."),
		).toBeInTheDocument();
	});

	it("Ask Alfy opens a composer naming the quote, with suggestion chips and the effect line", async () => {
		stubViewport(false);
		render(SelectionBubble, {
			position: { x: 0, y: 0 },
			quote: "Two adults; museums in the morning, cafés after",
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});
		await fireEvent.click(screen.getByRole("button", { name: "Ask Alfy" }));
		const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;
		expect(textbox.value).toBe("");
		expect(
			screen.getByText(/Ask Alfy about.*Two adults; museums/),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Less like a list" }),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Shorter" })).toBeInTheDocument();
		expect(
			screen.getByText(
				"Alfy replies in the margin and marks its change here, for you to keep or undo.",
			),
		).toBeInTheDocument();
	});

	it("a suggestion chip fills the draft text", async () => {
		stubViewport(false);
		render(SelectionBubble, {
			position: { x: 0, y: 0 },
			quote: "Book the flight",
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});
		await fireEvent.click(screen.getByRole("button", { name: "Ask Alfy" }));
		await fireEvent.click(screen.getByRole("button", { name: "Shorter" }));
		expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
			"Shorter",
		);
	});

	it("submitting Ask mode prefixes the body with @Alfy and hands up this composer's own rect", async () => {
		const onSubmit = vi.fn().mockResolvedValue(undefined);
		stubViewport(false);
		render(SelectionBubble, {
			position: { x: 0, y: 0 },
			quote: "Book the flight",
			onSubmit,
			onDismiss: vi.fn(),
		});
		await fireEvent.click(screen.getByRole("button", { name: "Ask Alfy" }));
		await fireEvent.input(screen.getByRole("textbox"), {
			target: { value: "Less like a list" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Ask Alfy" }));
		expect(onSubmit).toHaveBeenCalledWith(
			"@Alfy Less like a list",
			expect.anything(),
		);
	});

	it("submitting Comment mode without @Alfy posts the text as-is", async () => {
		const onSubmit = vi.fn().mockResolvedValue(undefined);
		stubViewport(false);
		render(SelectionBubble, {
			position: { x: 0, y: 0 },
			quote: "Book the flight",
			onSubmit,
			onDismiss: vi.fn(),
		});
		await fireEvent.click(screen.getByRole("button", { name: "Comment" }));
		await fireEvent.input(screen.getByRole("textbox"), {
			target: { value: "Too early?" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Comment" }));
		expect(onSubmit).toHaveBeenCalledWith("Too early?", expect.anything());
	});

	it("typing @Alfy in Comment mode turns the send button into Ask Alfy (the @Alfy switch)", async () => {
		stubViewport(false);
		render(SelectionBubble, {
			position: { x: 0, y: 0 },
			quote: "Book the flight",
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});
		await fireEvent.click(screen.getByRole("button", { name: "Comment" }));
		expect(
			screen.queryByRole("button", { name: "Ask Alfy" }),
		).not.toBeInTheDocument();
		await fireEvent.input(screen.getByRole("textbox"), {
			target: { value: "@Alfy tighten this up" },
		});
		expect(
			screen.getByRole("button", { name: "Ask Alfy" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Comment" }),
		).not.toBeInTheDocument();
	});

	it("Cancel dismisses without posting", async () => {
		const onSubmit = vi.fn();
		const onDismiss = vi.fn();
		stubViewport(false);
		render(SelectionBubble, {
			position: { x: 0, y: 0 },
			quote: "x",
			onSubmit,
			onDismiss,
		});
		await fireEvent.click(screen.getByRole("button", { name: "Comment" }));
		await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onSubmit).not.toHaveBeenCalled();
		expect(onDismiss).toHaveBeenCalled();
	});

	it("Escape in the composer dismisses without posting", async () => {
		const onSubmit = vi.fn();
		const onDismiss = vi.fn();
		stubViewport(false);
		render(SelectionBubble, {
			position: { x: 0, y: 0 },
			quote: "x",
			onSubmit,
			onDismiss,
		});
		await fireEvent.click(screen.getByRole("button", { name: "Ask Alfy" }));
		await fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
		expect(onSubmit).not.toHaveBeenCalled();
		expect(onDismiss).toHaveBeenCalled();
	});

	// rd/review-2-5.md:229-232 — Escape used to be wired to the textarea
	// alone, so it did nothing from a suggestion chip or the Cancel button —
	// the composer stayed open. Handled on the composer's own container now,
	// so it works from anywhere inside it.
	it("Escape from a suggestion chip dismisses the composer too, not just from the textarea", async () => {
		const onSubmit = vi.fn();
		const onDismiss = vi.fn();
		stubViewport(false);
		render(SelectionBubble, {
			position: { x: 0, y: 0 },
			quote: "x",
			onSubmit,
			onDismiss,
		});
		await fireEvent.click(screen.getByRole("button", { name: "Ask Alfy" }));
		const chip = screen.getByRole("button", { name: "Shorter" });
		chip.focus();
		await fireEvent.keyDown(chip, { key: "Escape" });
		expect(onSubmit).not.toHaveBeenCalled();
		expect(onDismiss).toHaveBeenCalled();
	});

	it("Escape from the Cancel button dismisses the composer too", async () => {
		const onSubmit = vi.fn();
		const onDismiss = vi.fn();
		stubViewport(false);
		render(SelectionBubble, {
			position: { x: 0, y: 0 },
			quote: "x",
			onSubmit,
			onDismiss,
		});
		await fireEvent.click(screen.getByRole("button", { name: "Comment" }));
		const cancelButton = screen.getByRole("button", { name: "Cancel" });
		cancelButton.focus();
		await fireEvent.keyDown(cancelButton, { key: "Escape" });
		expect(onSubmit).not.toHaveBeenCalled();
		expect(onDismiss).toHaveBeenCalled();
	});

	it("Cmd/Ctrl+Enter submits from the composer", async () => {
		const onSubmit = vi.fn().mockResolvedValue(undefined);
		stubViewport(false);
		render(SelectionBubble, {
			position: { x: 0, y: 0 },
			quote: "x",
			onSubmit,
			onDismiss: vi.fn(),
		});
		await fireEvent.click(screen.getByRole("button", { name: "Comment" }));
		await fireEvent.input(screen.getByRole("textbox"), {
			target: { value: "Quick note" },
		});
		await fireEvent.keyDown(screen.getByRole("textbox"), {
			key: "Enter",
			ctrlKey: true,
		});
		expect(onSubmit).toHaveBeenCalledWith("Quick note", expect.anything());
	});

	it("Escape dismisses the resting pill even when focus never moved into it (redesign §4.4)", async () => {
		const onDismiss = vi.fn();
		stubViewport(false);
		render(SelectionBubble, {
			position: { x: 0, y: 0 },
			quote: "x",
			onSubmit: vi.fn(),
			onDismiss,
		});
		// The pill's own buttons are never auto-focused — this dispatches from
		// `document`, exactly as it would with focus still in the editor.
		await fireEvent.keyDown(document, { key: "Escape" });
		expect(onDismiss).toHaveBeenCalledOnce();
	});

	it("positions the resting pill at the given coordinates", () => {
		stubViewport(false);
		render(SelectionBubble, {
			position: { x: 42, y: 84 },
			quote: "x",
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});
		const bubble = screen.getByTestId("selection-bubble");
		expect(bubble.style.left).toBe("42px");
		expect(bubble.style.top).toBe("84px");
	});

	it("flips its anchor transform below the selection when placement is 'below'", () => {
		stubViewport(false);
		render(SelectionBubble, {
			position: { x: 42, y: 84, placement: "below" },
			quote: "x",
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});
		expect(screen.getByTestId("selection-bubble").style.transform).toBe(
			"translate(-50%, 0%)",
		);
	});

	describe("on a phone viewport", () => {
		it("shows a docked bar instead of the floating pill", () => {
			stubViewport(true);
			render(SelectionBubble, {
				position: { x: 10, y: 20 },
				quote: "x",
				onSubmit: vi.fn(),
				onDismiss: vi.fn(),
			});
			const bar = screen.getByTestId("selection-bubble");
			expect(bar.className).toContain("selection-docked-bar");
			expect(
				screen.getByRole("button", { name: "Ask Alfy" }),
			).toBeInTheDocument();
		});

		it("opens the composer in a sheet, and still submits correctly", async () => {
			const onSubmit = vi.fn().mockResolvedValue(undefined);
			stubViewport(true);
			render(SelectionBubble, {
				position: { x: 10, y: 20 },
				quote: "Book the flight",
				onSubmit,
				onDismiss: vi.fn(),
			});
			await fireEvent.click(screen.getByRole("button", { name: "Comment" }));
			await waitFor(() => {
				expect(screen.getByRole("textbox")).toBeInTheDocument();
			});
			await fireEvent.input(screen.getByRole("textbox"), {
				target: { value: "Too early?" },
			});
			await fireEvent.click(screen.getByRole("button", { name: "Comment" }));
			// A phone sheet has nothing on-screen to "travel" from.
			expect(onSubmit).toHaveBeenCalledWith("Too early?", null);
		});
	});
});
