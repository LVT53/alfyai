import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactComment } from "$lib/server/services/artifacts/types";
import CommentThread from "./CommentThread.svelte";

function makeThread(overrides: Partial<ArtifactComment> = {}): ArtifactComment {
	return {
		id: "root-1",
		artifactId: "artifact-1",
		parentId: null,
		anchor: {
			kind: "text",
			blockId: "p1",
			quote: "Naschmarkt",
			prefix: "then the ",
			suffix: ", and",
		},
		author: "user",
		body: "Too early?",
		status: "open",
		createdAt: Date.now(),
		replies: [],
		...overrides,
	};
}

describe("CommentThread", () => {
	afterEach(() => {
		cleanup();
	});

	it("renders the root comment and every reply, oldest first as given", () => {
		render(CommentThread, {
			thread: makeThread({
				replies: [
					{
						id: "reply-1",
						artifactId: "artifact-1",
						parentId: "root-1",
						anchor: null,
						author: "alfy",
						body: "Moved it to ten.",
						status: "open",
						createdAt: Date.now(),
						replies: [],
					},
				],
			}),
			onResolve: vi.fn(),
			onSubmitReply: vi.fn(),
		});

		expect(screen.getByText("Too early?")).toBeInTheDocument();
		expect(screen.getByText("Moved it to ten.")).toBeInTheDocument();
	});

	it("opens a reply composer on Reply, and posts through onSubmitReply", async () => {
		const onSubmitReply = vi.fn().mockResolvedValue(undefined);
		render(CommentThread, {
			thread: makeThread(),
			onResolve: vi.fn(),
			onSubmitReply,
		});

		await fireEvent.click(screen.getByRole("button", { name: "Reply" }));
		const textbox = screen.getByRole("textbox");
		await fireEvent.input(textbox, { target: { value: "Ten works." } });
		await fireEvent.click(screen.getByRole("button", { name: "Post" }));

		expect(onSubmitReply).toHaveBeenCalledWith("root-1", "Ten works.");
	});

	it("closes the composer on Cancel without posting", async () => {
		const onSubmitReply = vi.fn();
		render(CommentThread, {
			thread: makeThread(),
			onResolve: vi.fn(),
			onSubmitReply,
		});

		await fireEvent.click(screen.getByRole("button", { name: "Reply" }));
		await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		expect(screen.queryByRole("textbox")).toBeNull();
		expect(onSubmitReply).not.toHaveBeenCalled();
	});

	it("shows 'Asking Alfy…' while an @Alfy-addressed reply is in flight", async () => {
		let resolveSubmit: () => void = () => {};
		const onSubmitReply = vi.fn(
			() => new Promise<void>((resolve) => (resolveSubmit = resolve)),
		);
		render(CommentThread, {
			thread: makeThread(),
			onResolve: vi.fn(),
			onSubmitReply,
		});

		await fireEvent.click(screen.getByRole("button", { name: "Reply" }));
		await fireEvent.input(screen.getByRole("textbox"), {
			target: { value: "@Alfy change it to ten." },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Post" }));

		expect(screen.getByText("Asking Alfy…")).toBeInTheDocument();
		resolveSubmit();
	});

	it("wires the root's resolve action to onResolve", async () => {
		const onResolve = vi.fn();
		render(CommentThread, {
			thread: makeThread(),
			onResolve,
			onSubmitReply: vi.fn(),
		});

		await fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
		expect(onResolve).toHaveBeenCalledWith(true);
	});
});
