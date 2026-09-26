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

	it("shows a Resolved badge once the thread is resolved", () => {
		render(CommentCard, { comment: makeComment({ status: "resolved" }) });
		expect(screen.getByText("Resolved")).toBeInTheDocument();
	});

	it("offers Resolve only when onResolve is passed, and fires it with the next state", async () => {
		const onResolve = vi.fn();
		render(CommentCard, {
			comment: makeComment({ status: "open" }),
			onResolve,
		});
		const button = screen.getByRole("button", { name: "Resolve" });
		await fireEvent.click(button);
		expect(onResolve).toHaveBeenCalledWith(true);
	});

	it("offers Reopen once resolved", async () => {
		const onResolve = vi.fn();
		render(CommentCard, {
			comment: makeComment({ status: "resolved" }),
			onResolve,
		});
		await fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
		expect(onResolve).toHaveBeenCalledWith(false);
	});

	it("never shows Resolve/Reopen when onResolve is omitted (e.g. a reply)", () => {
		render(CommentCard, { comment: makeComment({ parentId: "root-1" }) });
		expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
	});

	it("offers Reply only when onReplyClick is passed", async () => {
		const onReplyClick = vi.fn();
		render(CommentCard, { comment: makeComment(), onReplyClick });
		await fireEvent.click(screen.getByRole("button", { name: "Reply" }));
		expect(onReplyClick).toHaveBeenCalled();
	});
});
