import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactComment } from "$lib/server/services/artifacts/types";
import { makeBlock } from "$lib/shared/artifact-document/blocks";
import MarginPanel from "./MarginPanel.svelte";

function makeRoot(overrides: Partial<ArtifactComment> = {}): ArtifactComment {
	return {
		id: "root-1",
		artifactId: "artifact-1",
		parentId: null,
		anchor: {
			kind: "text",
			blockId: "p1",
			quote: "the flight",
			prefix: "Book ",
			suffix: " to Vienna.",
		},
		author: "user",
		body: "Too early?",
		status: "open",
		createdAt: Date.now(),
		replies: [],
		...overrides,
	};
}

describe("MarginPanel", () => {
	afterEach(() => {
		cleanup();
	});

	it("shows the empty state with no comments", () => {
		render(MarginPanel, {
			comments: [],
			blocks: [],
			onResolve: vi.fn(),
			onSubmitReply: vi.fn(),
		});
		expect(screen.getByText("No comments yet.")).toBeInTheDocument();
	});

	it("renders one thread per root comment", () => {
		render(MarginPanel, {
			comments: [
				makeRoot({ id: "root-1", body: "Too early?" }),
				makeRoot({ id: "root-2", body: "Nice choice." }),
			],
			blocks: [makeBlock("p1", "paragraph", "Book the flight to Vienna.")],
			onResolve: vi.fn(),
			onSubmitReply: vi.fn(),
		});
		expect(screen.getByText("Too early?")).toBeInTheDocument();
		expect(screen.getByText("Nice choice.")).toBeInTheDocument();
	});

	it("marks a comment Exact when its quote resolves cleanly", () => {
		render(MarginPanel, {
			comments: [makeRoot()],
			blocks: [makeBlock("p1", "paragraph", "Book the flight to Vienna.")],
			onResolve: vi.fn(),
			onSubmitReply: vi.fn(),
		});
		expect(screen.getByText("Exact")).toBeInTheDocument();
	});

	it("marks a comment Moved when its block changed nearby", () => {
		render(MarginPanel, {
			comments: [makeRoot()],
			blocks: [
				makeBlock("p1", "paragraph", "Reserve the flight for Vienna soon."),
			],
			onResolve: vi.fn(),
			onSubmitReply: vi.fn(),
		});
		expect(screen.getByText("Moved")).toBeInTheDocument();
	});

	// T10.9: the one state a user cannot cause on purpose — never a crash,
	// the body and thread stay visible.
	it("marks a comment Orphaned, keeping its body, once its text is gone", () => {
		render(MarginPanel, {
			comments: [makeRoot({ body: "Too early?" })],
			blocks: [makeBlock("p1", "paragraph", "Nothing about travel here now.")],
			onResolve: vi.fn(),
			onSubmitReply: vi.fn(),
		});
		expect(screen.getByText("Orphaned")).toBeInTheDocument();
		expect(screen.getByText("Too early?")).toBeInTheDocument();
	});

	// T10.9: a row whose anchor never parsed (a malformed/unparseable Anchor
	// in the DB) is an orphan too, never a crash, and its body/thread survive.
	it("marks a null (unparseable) anchor Orphaned too, without throwing", () => {
		expect(() =>
			render(MarginPanel, {
				comments: [makeRoot({ anchor: null, body: "Still here?" })],
				blocks: [makeBlock("p1", "paragraph", "Book the flight to Vienna.")],
				onResolve: vi.fn(),
				onSubmitReply: vi.fn(),
			}),
		).not.toThrow();
		expect(screen.getByText("Orphaned")).toBeInTheDocument();
		expect(screen.getByText("Still here?")).toBeInTheDocument();
	});

	it("delegates resolve to onResolve with the comment's own id", async () => {
		const onResolve = vi.fn();
		render(MarginPanel, {
			comments: [makeRoot({ id: "root-9" })],
			blocks: [makeBlock("p1", "paragraph", "Book the flight to Vienna.")],
			onResolve,
			onSubmitReply: vi.fn(),
		});
		await fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
		expect(onResolve).toHaveBeenCalledWith("root-9", true);
	});

	// Margin placement follow-up: orphaned threads (nowhere to sit beside)
	// render in their own clearly-labelled group, never mixed into the main
	// list the way a plain flat list used to show them.
	it("puts an orphaned comment in its own labelled group, separate from a resolved one", () => {
		render(MarginPanel, {
			comments: [
				makeRoot({
					id: "found",
					body: "Still relevant",
					anchor: {
						kind: "text",
						blockId: "p1",
						quote: "the flight",
						prefix: "Book ",
						suffix: " to Vienna.",
					},
				}),
				makeRoot({ id: "gone", body: "Where did this go?", anchor: null }),
			],
			blocks: [makeBlock("p1", "paragraph", "Book the flight to Vienna.")],
			onResolve: vi.fn(),
			onSubmitReply: vi.fn(),
		});

		const orphanedGroup = screen.getByTestId("margin-orphaned-group");
		expect(orphanedGroup).toBeInTheDocument();
		expect(
			within(orphanedGroup).getByText("Where did this go?"),
		).toBeInTheDocument();
		expect(
			within(orphanedGroup).queryByText("Still relevant"),
		).not.toBeInTheDocument();
		expect(screen.getByText("Still relevant")).toBeInTheDocument();
	});

	it("shows no orphaned group at all when every comment resolves cleanly", () => {
		render(MarginPanel, {
			comments: [makeRoot()],
			blocks: [makeBlock("p1", "paragraph", "Book the flight to Vienna.")],
			onResolve: vi.fn(),
			onSubmitReply: vi.fn(),
		});
		expect(
			screen.queryByTestId("margin-orphaned-group"),
		).not.toBeInTheDocument();
	});
});
