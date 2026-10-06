import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactComment } from "$lib/server/services/artifacts/types";
import {
	ALFY_EMPTY_REPLY_MARKER,
	ALFY_PARTIAL_REFUSAL_SUFFIX,
	ALFY_REFUSED_MARKER,
	withSkippedOps,
} from "$lib/shared/artifact-document/alfy-reply";
import { uiLanguage } from "$lib/stores/settings";
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

	// rd/review-2-5.md:272-275 — the user's own row showed a placeholder "U"
	// next to "Te"/"You" instead of the signed-in user's real avatar.
	describe("the current user's own avatar", () => {
		it("falls back to the placeholder 'U' when the caller supplies no current user", () => {
			const { container } = render(CommentCard, {
				comment: makeComment({ body: "Too early?" }),
			});
			expect(
				container.querySelector(".avatar-circle")?.textContent?.trim(),
			).toBe("U");
		});

		it("shows the signed-in user's own initial once the caller supplies currentUserId/currentUserName", () => {
			const { container } = render(CommentCard, {
				comment: makeComment({ body: "Too early?" }),
				currentUserId: "alice-1",
				currentUserName: "Alice",
			});
			expect(
				container.querySelector(".avatar-circle")?.textContent?.trim(),
			).toBe("A");
		});
	});
});

describe("CommentCard on a Canvas: what Alfy says about a board", () => {
	afterEach(() => {
		cleanup();
		uiLanguage.set("en");
	});

	const alfy = (body: string) => makeComment({ author: "alfy", body });

	it("names each op that was skipped, in the reader's language, under Alfy's own note", () => {
		uiLanguage.set("en");
		render(CommentCard, {
			comment: alfy(
				withSkippedOps("Moved the museum note.", [
					{ target: "Museum, 14:00", reason: "unknown_id" },
					{ target: "Lunch", reason: "duplicate_id" },
				]),
			),
			kind: "canvas",
		});
		expect(screen.getByText("Moved the museum note.")).toBeInTheDocument();
		expect(
			screen.getByText("Part of this could not be applied safely."),
		).toBeInTheDocument();
		expect(
			screen.getByText("Museum, 14:00: nothing is at that position any more"),
		).toBeInTheDocument();
		expect(
			screen.getByText("Lunch: that id already exists"),
		).toBeInTheDocument();
	});

	it("never shows the marker itself", () => {
		render(CommentCard, {
			comment: alfy(
				withSkippedOps("Done.", [{ target: "x", reason: "cycle" }]),
			),
			kind: "canvas",
		});
		expect(document.body.textContent).not.toContain("[[alfy");
	});

	it("says it in Hungarian", () => {
		uiLanguage.set("hu");
		render(CommentCard, {
			comment: alfy(
				withSkippedOps("Kész.", [{ target: "Múzeum", reason: "unknown_id" }]),
			),
			kind: "canvas",
		});
		expect(screen.getByText("Múzeum: már nincs ott semmi")).toBeInTheDocument();
	});

	// Ruling 67 for the `@Alfy` reply (RC-3 N8): a note the reader changed after the
	// model read the board is left alone, and the card says so in their language.
	it("says a note the reader changed after Alfy looked was left alone, in English and in Hungarian", () => {
		const reply = alfy(
			withSkippedOps("Moved the time.", [
				{ target: "Museum, 14:00", reason: "stale" },
			]),
		);
		uiLanguage.set("en");
		const { unmount } = render(CommentCard, { comment: reply, kind: "canvas" });
		expect(
			screen.getByText(
				"Museum, 14:00: you changed it after Alfy looked at the board, so Alfy left it alone",
			),
		).toBeInTheDocument();
		unmount();
		uiLanguage.set("hu");
		render(CommentCard, { comment: reply, kind: "canvas" });
		expect(
			screen.getByText(
				"Museum, 14:00: a tábla megtekintése után módosítottad, ezért Alfy nem nyúlt hozzá",
			),
		).toBeInTheDocument();
	});

	it("shows the plain code for a reason it has no words for, and just the reason when the op had no target", () => {
		render(CommentCard, {
			comment: alfy(
				withSkippedOps("Done.", [
					{ target: "", reason: "cycle" },
					{ target: "Box", reason: "some_new_reason" },
				]),
			),
			kind: "canvas",
		});
		expect(
			screen.getByText("A frame cannot sit inside its own frame"),
		).toBeInTheDocument();
		expect(screen.getByText("Box: some_new_reason")).toBeInTheDocument();
	});

	it("still shows a note that is empty as Done, beside what was skipped", () => {
		render(CommentCard, {
			comment: alfy(
				withSkippedOps(ALFY_EMPTY_REPLY_MARKER, [
					{ target: "a", reason: "unknown_id" },
				]),
			),
			kind: "canvas",
		});
		expect(screen.getByText("Done.")).toBeInTheDocument();
		expect(
			screen.getByText("a: nothing is at that position any more"),
		).toBeInTheDocument();
	});

	it("says the BOARD was left alone for a refusal, not the text", () => {
		render(CommentCard, { comment: alfy(ALFY_REFUSED_MARKER), kind: "canvas" });
		expect(
			screen.getByText(
				"I left the board as it is — this comment didn't lead to a change I could make safely.",
			),
		).toBeInTheDocument();
	});

	it("still says the text was left alone on a Document", () => {
		render(CommentCard, { comment: alfy(ALFY_REFUSED_MARKER) });
		expect(
			screen.getByText(
				"I left the text as it is — this comment didn't lead to a change I could make safely.",
			),
		).toBeInTheDocument();
	});

	it("never reads a USER's comment for a marker, even one that looks like it", () => {
		const looksLike = withSkippedOps("Hi", [
			{ target: "x", reason: "unknown_id" },
		]);
		render(CommentCard, {
			comment: makeComment({ author: "user", body: looksLike }),
			kind: "canvas",
		});
		expect(
			screen.queryByText("Part of this could not be applied safely."),
		).toBeNull();
	});
});
