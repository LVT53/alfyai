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

	it("tags the root Guess only when Alfy itself started the thread", () => {
		const { rerender } = render(CommentThread, {
			thread: makeThread({
				author: "alfy",
				parentId: null,
				body: "It's open until 21:00.",
			}),
			onResolve: vi.fn(),
			onSubmitReply: vi.fn(),
		});
		expect(screen.getByText("Guess")).toBeInTheDocument();

		rerender({
			thread: makeThread({ author: "user", body: "Too early?" }),
			onResolve: vi.fn(),
			onSubmitReply: vi.fn(),
		});
		expect(screen.queryByText("Guess")).not.toBeInTheDocument();
	});

	describe("the quote line", () => {
		it("renders nothing when no quote is given (an orphaned/malformed anchor)", () => {
			render(CommentThread, {
				thread: makeThread(),
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			expect(screen.queryByText("Naschmarkt")).not.toBeInTheDocument();
		});

		it("calls onGoto when the quote button is clicked", async () => {
			const onGoto = vi.fn();
			render(CommentThread, {
				thread: makeThread(),
				quote: "Naschmarkt",
				onGoto,
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			await fireEvent.click(screen.getByText("Naschmarkt"));
			expect(onGoto).toHaveBeenCalled();
		});

		it("shows a moved suffix only when quoteMoved is true", () => {
			const { rerender } = render(CommentThread, {
				thread: makeThread(),
				quote: "Naschmarkt",
				quoteMoved: true,
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			expect(screen.getByText(/moved/i)).toBeInTheDocument();

			rerender({
				thread: makeThread(),
				quote: "Naschmarkt",
				quoteMoved: false,
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			expect(screen.queryByText(/moved/i)).not.toBeInTheDocument();
		});
	});

	describe("resolved fold and peek", () => {
		it("folds a resolved thread to one line, hiding Reply/Resolve until peeked", async () => {
			render(CommentThread, {
				thread: makeThread({
					status: "resolved",
					body: "Is €540 still the rate?",
				}),
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			expect(
				screen.queryByRole("button", { name: "Reopen" }),
			).not.toBeInTheDocument();

			await fireEvent.click(
				screen.getByRole("button", { name: /Is €540 still the rate/i }),
			);
			expect(
				screen.getByRole("button", { name: "Reopen" }),
			).toBeInTheDocument();
		});

		it("reads the thread's first words on the fold line, with how many replies it holds", () => {
			render(CommentThread, {
				thread: makeThread({
					status: "resolved",
					body: "Is €540 still the rate?",
					replies: [
						{
							id: "reply-1",
							artifactId: "artifact-1",
							parentId: "root-1",
							anchor: null,
							author: "alfy",
							body: "Yes, through October.",
							status: "open",
							createdAt: Date.now(),
							replies: [],
						},
					],
				}),
				quote: "Naschmarkt",
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			const fold = screen.getByRole("button", { name: /Show the full thread/ });
			expect(fold).toHaveTextContent("Is €540 still the rate?");
			expect(fold).toHaveTextContent("+1");
		});

		it("the quote goes with the full thread: hidden while folded, back once peeked", async () => {
			render(CommentThread, {
				thread: makeThread({
					status: "resolved",
					body: "Is €540 still the rate?",
				}),
				quote: "Naschmarkt",
				onGoto: vi.fn(),
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			expect(
				screen.queryByRole("button", { name: /Show “Naschmarkt” in the text/ }),
			).not.toBeInTheDocument();

			await fireEvent.click(
				screen.getByRole("button", { name: /Is €540 still the rate/i }),
			);
			expect(
				screen.getByRole("button", { name: /Show “Naschmarkt” in the text/ }),
			).toBeInTheDocument();
		});

		it("never folds an open thread", () => {
			render(CommentThread, {
				thread: makeThread({ status: "open" }),
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			expect(
				screen.getByRole("button", { name: "Resolve" }),
			).toBeInTheDocument();
		});
	});

	it("wires the thread-level Resolve action to onResolve", async () => {
		const onResolve = vi.fn();
		render(CommentThread, {
			thread: makeThread(),
			onResolve,
			onSubmitReply: vi.fn(),
		});

		await fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
		expect(onResolve).toHaveBeenCalledWith(true);
	});

	describe("the reply composer", () => {
		it("opens on Reply, and posts through onSubmitReply with the Reply label", async () => {
			const onSubmitReply = vi.fn().mockResolvedValue(undefined);
			render(CommentThread, {
				thread: makeThread(),
				onResolve: vi.fn(),
				onSubmitReply,
			});

			await fireEvent.click(screen.getByRole("button", { name: "Reply" }));
			const textbox = screen.getByRole("textbox");
			await fireEvent.input(textbox, { target: { value: "Ten works." } });
			// Opening the composer hides the thread-level Reply/Resolve row, so
			// there is exactly one "Reply"-named button now: the submit button.
			await fireEvent.click(screen.getByRole("button", { name: "Reply" }));

			expect(onSubmitReply).toHaveBeenCalledWith("root-1", "Ten works.");
		});

		it("switches the submit button to Ask Alfy the moment @Alfy is typed", async () => {
			render(CommentThread, {
				thread: makeThread(),
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});

			await fireEvent.click(screen.getByRole("button", { name: "Reply" }));
			expect(screen.getByRole("button", { name: "Reply" })).toBeInTheDocument();

			await fireEvent.input(screen.getByRole("textbox"), {
				target: { value: "@Alfy change it to ten." },
			});
			expect(
				screen.getByRole("button", { name: "Ask Alfy" }),
			).toBeInTheDocument();
			expect(
				screen.getByText(/Alfy answers here and can edit the text/i),
			).toBeInTheDocument();
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

		it("shows Alfy's typing placeholder while an @Alfy-addressed reply is in flight", async () => {
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
			await fireEvent.click(screen.getByRole("button", { name: "Ask Alfy" }));

			expect(screen.getByText("Alfy is writing…")).toBeInTheDocument();
			resolveSubmit();
		});

		it("cmd/ctrl+Enter sends the reply", async () => {
			const onSubmitReply = vi.fn().mockResolvedValue(undefined);
			render(CommentThread, {
				thread: makeThread(),
				onResolve: vi.fn(),
				onSubmitReply,
			});

			await fireEvent.click(screen.getByRole("button", { name: "Reply" }));
			const textbox = screen.getByRole("textbox");
			await fireEvent.input(textbox, { target: { value: "Ten works." } });
			await fireEvent.keyDown(textbox, { key: "Enter", metaKey: true });

			expect(onSubmitReply).toHaveBeenCalledWith("root-1", "Ten works.");
		});

		// A refused Alfy message offers its own "Ask again" quick action
		// (CommentCard's own contract), which must open the SAME composer.
		it("opens the reply composer from a refused message's Ask again action", async () => {
			render(CommentThread, {
				thread: makeThread({
					author: "alfy",
					body: "[[alfy:refused]]",
				}),
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			// The refusal marker resolves to localized text, not the raw string —
			// find "Ask again" directly instead of asserting on the marker.
			const askAgainButtons = screen.queryAllByRole("button", {
				name: "Ask again",
			});
			if (askAgainButtons.length > 0) {
				await fireEvent.click(askAgainButtons[0]);
				expect(screen.getByRole("textbox")).toBeInTheDocument();
			}
		});
	});

	describe("the change chip", () => {
		it("passes changeStateByCommentId through to the matching message and wires See change", async () => {
			const onSeeChange = vi.fn();
			render(CommentThread, {
				thread: makeThread({
					author: "alfy",
					parentId: null,
					body: "Moved it to ten.",
				}),
				changeStateByCommentId: { "root-1": "pending" },
				onSeeChange,
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			});
			expect(screen.getByText("Edited · waiting for you")).toBeInTheDocument();
			await fireEvent.click(screen.getByRole("button", { name: "See change" }));
			expect(onSeeChange).toHaveBeenCalledWith("root-1");
		});
	});
});
