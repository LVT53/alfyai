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
