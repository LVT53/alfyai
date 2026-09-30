import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import CommentComposer from "./CommentComposer.svelte";

// The box a NEW thread is written in, for every kind whose comments start
// somewhere other than a text selection. What is asserted is the words it lets
// go of and when: the button becomes "Ask Alfy" the moment the words ask for
// Alfy, an empty comment cannot be posted, and a failure keeps what was typed.

beforeEach(() => {
	uiLanguage.set("en");
});

afterEach(() => {
	cleanup();
});

function mount(onsubmit = vi.fn().mockResolvedValue(undefined)) {
	const oncancel = vi.fn();
	render(CommentComposer, {
		header: "New comment on: Trains card",
		placeholder: "Write a comment. Use @Alfy to ask for a change.",
		alfyHint: "Alfy answers here and can change the board.",
		onsubmit,
		oncancel,
	});
	return { onsubmit, oncancel };
}

const field = () => screen.getByRole("textbox") as HTMLTextAreaElement;

describe("CommentComposer", () => {
	it("names what the comment is on, and puts the reader in the box", () => {
		mount();
		expect(screen.getByText("New comment on: Trains card")).toBeTruthy();
		expect(field().placeholder).toBe(
			"Write a comment. Use @Alfy to ask for a change.",
		);
		expect(document.activeElement).toBe(field());
	});

	it("takes the focus back when a sheet or a drawer moves it away just after opening", () => {
		vi.useFakeTimers();
		try {
			mount();
			// A dialog's own focus handling runs a moment after mount and puts the focus on its first control.
			const other = document.createElement("button");
			document.body.appendChild(other);
			other.focus();
			expect(document.activeElement).toBe(other);
			vi.advanceTimersByTime(100);
			expect(document.activeElement).toBe(field());
			other.remove();
		} finally {
			vi.useRealTimers();
		}
	});

	it("cannot post an empty comment", async () => {
		mount();
		const post = screen.getByRole("button", {
			name: "Post",
		}) as HTMLButtonElement;
		expect(post.disabled).toBe(true);
		await fireEvent.input(field(), { target: { value: "   " } });
		expect(post.disabled).toBe(true);
		await fireEvent.input(field(), { target: { value: "Move this?" } });
		expect(post.disabled).toBe(false);
	});

	it("posts the words, trimmed", async () => {
		const { onsubmit } = mount();
		await fireEvent.input(field(), { target: { value: "  Is this right?  " } });
		await fireEvent.click(screen.getByRole("button", { name: "Post" }));
		expect(onsubmit).toHaveBeenCalledWith("Is this right?");
	});

	it("turns the button into Ask Alfy, with the hint, the moment the words mention Alfy", async () => {
		mount();
		expect(
			screen.queryByText("Alfy answers here and can change the board."),
		).toBeNull();
		await fireEvent.input(field(), {
			target: { value: "@Alfy make this a list" },
		});
		expect(screen.getByRole("button", { name: "Ask Alfy" })).toBeTruthy();
		expect(
			screen.getByText("Alfy answers here and can change the board."),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Post" })).toBeNull();
	});

	it("posts with Ctrl+Enter, and with Cmd+Enter", async () => {
		const { onsubmit } = mount();
		await fireEvent.input(field(), { target: { value: "One" } });
		await fireEvent.keyDown(field(), { key: "Enter", ctrlKey: true });
		expect(onsubmit).toHaveBeenCalledTimes(1);
		await fireEvent.keyDown(field(), { key: "Enter", metaKey: true });
		expect(onsubmit).toHaveBeenCalledTimes(2);
	});

	it("lets go on Cancel and on Escape, without posting", async () => {
		const { oncancel, onsubmit } = mount();
		await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await fireEvent.keyDown(field(), { key: "Escape" });
		expect(oncancel).toHaveBeenCalledTimes(2);
		expect(onsubmit).not.toHaveBeenCalled();
	});

	it("keeps what was typed and says so when the post fails", async () => {
		const { onsubmit } = mount(vi.fn().mockRejectedValue(new Error("offline")));
		await fireEvent.input(field(), { target: { value: "Keep me" } });
		await fireEvent.click(screen.getByRole("button", { name: "Post" }));
		await vi.waitFor(() =>
			expect(screen.getByRole("alert").textContent).toContain(
				"Could not post this comment.",
			),
		);
		expect(field().value).toBe("Keep me");
		expect(onsubmit).toHaveBeenCalledTimes(1);
		expect(
			(screen.getByRole("button", { name: "Post" }) as HTMLButtonElement)
				.disabled,
		).toBe(false);
	});

	it("locks the box while the post is on its way, so a second press cannot post twice", async () => {
		let release: () => void = () => {};
		const { onsubmit } = mount(
			vi.fn(
				() =>
					new Promise<void>((resolve) => {
						release = resolve;
					}),
			),
		);
		await fireEvent.input(field(), { target: { value: "Once" } });
		await fireEvent.click(screen.getByRole("button", { name: "Post" }));
		expect(field().disabled).toBe(true);
		await fireEvent.click(screen.getByRole("button", { name: "Post" }));
		expect(onsubmit).toHaveBeenCalledTimes(1);
		release();
	});

	it("says the same in Hungarian", async () => {
		uiLanguage.set("hu");
		mount();
		await fireEvent.input(field(), { target: { value: "Szia @Alfy" } });
		expect(
			screen.getByRole("button", { name: "Alfy megkérdezése" }),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "Mégse" })).toBeTruthy();
	});

	// A request started as "Ask Alfy" (a selection's pill, the toolbar) begins with
	// Alfy's name, so the reader only writes what to do.
	it("can begin with words already in the box, and then says Ask Alfy at once", () => {
		const onsubmit = vi.fn().mockResolvedValue(undefined);
		render(CommentComposer, {
			header: "New comment on: Trains card",
			placeholder: "Write a comment. Use @Alfy to ask for a change.",
			alfyHint: "Alfy answers here and can change the board.",
			initialText: "@Alfy ",
			onsubmit,
			oncancel: vi.fn(),
		});
		expect(field().value).toBe("@Alfy ");
		expect(document.activeElement).toBe(field());
		// The caret is after the words, so what is typed follows them.
		expect(field().selectionStart).toBe("@Alfy ".length);
		expect(screen.getByRole("button", { name: /Ask Alfy/ })).toBeTruthy();
	});
});
