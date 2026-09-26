import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import SelectionBubble from "./SelectionBubble.svelte";

describe("SelectionBubble", () => {
	afterEach(() => {
		cleanup();
	});

	it("shows Ask Alfy and Comment when a selection is active", () => {
		render(SelectionBubble, {
			position: { x: 10, y: 20 },
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});
		expect(
			screen.getByRole("button", { name: "Ask Alfy" }),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Comment" })).toBeInTheDocument();
	});

	it("Comment opens an empty composer", async () => {
		render(SelectionBubble, {
			position: { x: 0, y: 0 },
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});
		await fireEvent.click(screen.getByRole("button", { name: "Comment" }));
		const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;
		expect(textbox.value).toBe("");
	});

	it("Ask Alfy opens a composer pre-filled with '@Alfy '", async () => {
		render(SelectionBubble, {
			position: { x: 0, y: 0 },
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});
		await fireEvent.click(screen.getByRole("button", { name: "Ask Alfy" }));
		const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;
		expect(textbox.value).toBe("@Alfy ");
	});

	it("posts the composer's text through onSubmit", async () => {
		const onSubmit = vi.fn().mockResolvedValue(undefined);
		render(SelectionBubble, {
			position: { x: 0, y: 0 },
			onSubmit,
			onDismiss: vi.fn(),
		});
		await fireEvent.click(screen.getByRole("button", { name: "Comment" }));
		await fireEvent.input(screen.getByRole("textbox"), {
			target: { value: "Too early?" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Post" }));
		expect(onSubmit).toHaveBeenCalledWith("Too early?");
	});

	it("Cancel dismisses without posting", async () => {
		const onSubmit = vi.fn();
		const onDismiss = vi.fn();
		render(SelectionBubble, { position: { x: 0, y: 0 }, onSubmit, onDismiss });
		await fireEvent.click(screen.getByRole("button", { name: "Comment" }));
		await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onSubmit).not.toHaveBeenCalled();
		expect(onDismiss).toHaveBeenCalled();
	});

	it("positions itself at the given coordinates", () => {
		render(SelectionBubble, {
			position: { x: 42, y: 84 },
			onSubmit: vi.fn(),
			onDismiss: vi.fn(),
		});
		const bubble = screen.getByTestId("selection-bubble");
		expect(bubble.style.left).toBe("42px");
		expect(bubble.style.top).toBe("84px");
	});
});
