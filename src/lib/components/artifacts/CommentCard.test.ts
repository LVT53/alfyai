import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactComment } from "$lib/server/services/artifacts/types";
import {
	ALFY_EMPTY_REPLY_MARKER,
	ALFY_PARTIAL_REFUSAL_SUFFIX,
	ALFY_REFUSED_MARKER,
} from "$lib/shared/artifact-document/alfy-reply";
import CommentCard from "./CommentCard.svelte";

function makeComment(
	overrides: Partial<ArtifactComment> = {},
): ArtifactComment {
	return {
		id: "comment-1",
		artifactId: "artifact-1",
		parentId: null,
		anchor: null,
		author: "user",
		body: "Too early?",
		status: "open",
		createdAt: Date.now(),
		replies: [],
		...overrides,
	};
}

describe("CommentCard", () => {
	afterEach(() => {
		cleanup();
	});

	it("shows the user's own body text and the 'You' author label", () => {
		render(CommentCard, { comment: makeComment({ body: "Too early?" }) });
		expect(screen.getByText("Too early?")).toBeInTheDocument();
		expect(screen.getByText("You")).toBeInTheDocument();
	});

	it("labels an Alfy-authored comment as Alfy", () => {
		render(CommentCard, {
			comment: makeComment({ author: "alfy", body: "Yes, that works." }),
		});
		expect(screen.getByText("Alfy")).toBeInTheDocument();
	});

	it("highlights an @Alfy mention inside the body", () => {
		render(CommentCard, {
			comment: makeComment({ body: "@Alfy can you check this?" }),
		});
		const mention = screen.getByText("@Alfy");
		expect(mention.className).toContain("comment-card-mention");
	});

	it("shows the Guess tag only when the caller marks this message a guess", () => {
		const { rerender } = render(CommentCard, {
			comment: makeComment({ author: "alfy", body: "It's open until 21:00." }),
			isGuess: true,
		});
		expect(screen.getByText("Guess")).toBeInTheDocument();

		rerender({
			comment: makeComment({ author: "alfy", body: "It's open until 21:00." }),
			isGuess: false,
		});
		expect(screen.queryByText("Guess")).not.toBeInTheDocument();
	});

	// T10.5's refusal marker never reaches the user as literal text.
	it("renders the refused marker as the localized notice, not the raw marker", () => {
		render(CommentCard, {
			comment: makeComment({ author: "alfy", body: ALFY_REFUSED_MARKER }),
		});
		expect(screen.queryByText(ALFY_REFUSED_MARKER)).not.toBeInTheDocument();
		expect(screen.getByText(/left the text as it is/i)).toBeInTheDocument();
	});

	it("renders the empty-reply marker as 'Done.'", () => {
		render(CommentCard, {
			comment: makeComment({ author: "alfy", body: ALFY_EMPTY_REPLY_MARKER }),
		});
		expect(screen.getByText("Done.")).toBeInTheDocument();
	});

	describe("a refused @Alfy reply", () => {
		it("offers Ask again only when onAskAgain is passed, and fires it", async () => {
			const onAskAgain = vi.fn();
			render(CommentCard, {
				comment: makeComment({ author: "alfy", body: ALFY_REFUSED_MARKER }),
				onAskAgain,
			});
			const button = screen.getByRole("button", { name: "Ask again" });
			await fireEvent.click(button);
			expect(onAskAgain).toHaveBeenCalled();
		});

		it("never offers Ask again on an ordinary (non-refused) message", () => {
			render(CommentCard, {
				comment: makeComment({ author: "alfy", body: "Done that." }),
				onAskAgain: vi.fn(),
			});
			expect(
				screen.queryByRole("button", { name: "Ask again" }),
			).not.toBeInTheDocument();
		});
	});

	// RV-1B, coordinator item 8: a reply that both applied and refused ops
	// carries Alfy's own note PLUS this suffix — the note must still show
	// (never replaced, unlike the two whole-body markers above), alongside a
	// visible notice that something was refused, and the raw marker itself
	// must never leak into the rendered text.
	describe("RV-1B, coordinator item 8: a partially-refused @Alfy reply", () => {
		it("shows Alfy's own note plus a visible partial-refusal notice, never the raw suffix", () => {
			render(CommentCard, {
				comment: makeComment({
					author: "alfy",
					body: `Changed the destination to Budapest.${ALFY_PARTIAL_REFUSAL_SUFFIX}`,
				}),
			});
			expect(
				screen.getByText("Changed the destination to Budapest."),
			).toBeInTheDocument();
			expect(
				screen.getByText("Part of this could not be applied safely."),
			).toBeInTheDocument();
			expect(screen.queryByText(/\[\[alfy:/)).not.toBeInTheDocument();
		});

		it("still resolves the empty-reply marker's own localized text when the note itself was empty", () => {
			render(CommentCard, {
				comment: makeComment({
					author: "alfy",
					body: `${ALFY_EMPTY_REPLY_MARKER}${ALFY_PARTIAL_REFUSAL_SUFFIX}`,
				}),
			});
			expect(screen.getByText("Done.")).toBeInTheDocument();
			expect(
				screen.getByText("Part of this could not be applied safely."),
			).toBeInTheDocument();
		});

		it("shows no partial-refusal notice for an ordinary applied reply", () => {
			render(CommentCard, {
				comment: makeComment({
					author: "alfy",
					body: "Changed the destination to Prague.",
				}),
			});
			expect(
				screen.queryByText("Part of this could not be applied safely."),
			).not.toBeInTheDocument();
		});

		it("never treats a USER's own comment as a partial refusal, even if it happens to end the same way", () => {
			render(CommentCard, {
				comment: makeComment({
					author: "user",
					body: `Please retry${ALFY_PARTIAL_REFUSAL_SUFFIX}`,
				}),
			});
			expect(
				screen.queryByText("Part of this could not be applied safely."),
			).not.toBeInTheDocument();
		});
	});

	describe("the change chip", () => {
		it("renders nothing when changeState is omitted", () => {
			render(CommentCard, {
				comment: makeComment({ author: "alfy", body: "Moved it to ten." }),
			});
			expect(screen.queryByText("Kept")).not.toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: "See change" }),
			).not.toBeInTheDocument();
		});

		it("shows the pending label and a working See change action", async () => {
			const onSeeChange = vi.fn();
			render(CommentCard, {
				comment: makeComment({ author: "alfy", body: "Moved it to ten." }),
				changeState: "pending",
				onSeeChange,
			});
			expect(screen.getByText("Edited · waiting for you")).toBeInTheDocument();
			await fireEvent.click(screen.getByRole("button", { name: "See change" }));
			expect(onSeeChange).toHaveBeenCalled();
		});

		it("shows Kept once the change is kept", () => {
			render(CommentCard, {
				comment: makeComment({ author: "alfy", body: "Moved it to ten." }),
				changeState: "kept",
			});
			expect(screen.getByText("Kept")).toBeInTheDocument();
		});

		it("shows Undone once the change is undone", () => {
			render(CommentCard, {
				comment: makeComment({ author: "alfy", body: "Moved it to ten." }),
				changeState: "undone",
			});
			expect(screen.getByText("Undone")).toBeInTheDocument();
		});
	});
});
