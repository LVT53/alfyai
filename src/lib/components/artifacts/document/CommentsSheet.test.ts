import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import type { ComponentProps } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactComment } from "$lib/server/services/artifacts/types";
import type { DocumentBlock } from "$lib/shared/artifact-document/blocks";
import CommentsSheet from "./CommentsSheet.svelte";

const COMMENT: ArtifactComment = {
	id: "c1",
	artifactId: "artifact-1",
	parentId: null,
	anchor: {
		kind: "text",
		blockId: "p1",
		quote: "one proper concert",
		prefix: "",
		suffix: "",
	},
	author: "user",
	body: "Anna says the Musikverein sells out early.",
	status: "open",
	createdAt: Date.now(),
	replies: [],
};

const BLOCK: DocumentBlock = {
	id: "p1",
	kind: "paragraph",
	markdown: "one proper concert",
	hash: "h1",
	label: "one proper concert",
};

function baseProps(
	overrides: Partial<ComponentProps<typeof CommentsSheet>> = {},
) {
	return {
		presentation: "sheet" as const,
		onClose: vi.fn(),
		comments: [COMMENT],
		// Matches COMMENT's anchor so it resolves "exact", not orphaned — an
		// orphaned comment renders folded into the collapsed removed-text
		// group, which is not what most of these tests are exercising.
		blocks: [BLOCK],
		tabs: [],
		activeTabId: "",
		onResolve: vi.fn(),
		onSubmitReply: vi.fn(),
		...overrides,
	};
}

describe("CommentsSheet", () => {
	afterEach(() => {
		cleanup();
	});

	it("presentation='sheet': renders MarginPanel inside a DialogShell sheet, named Comments", async () => {
		render(CommentsSheet, baseProps());

		const dialog = await screen.findByRole("dialog", { name: "Comments" });
		expect(dialog).toBeInTheDocument();
		// MarginPanel's own rail header draws the one VISIBLE "Comments"
		// heading; DialogShell's own title stays visually hidden
		// (`titleVisuallyHidden`) and still carries the dialog's accessible
		// name (asserted above) without drawing a second one on screen.
		expect(dialog.querySelector(".margin-panel-title")).toHaveTextContent(
			"Comments",
		);
		expect(
			within(dialog).getByText("Anna says the Musikverein sells out early."),
		).toBeInTheDocument();
	});

	it("presentation='drawer': renders a portaled drawer, named Comments", async () => {
		render(CommentsSheet, baseProps({ presentation: "drawer" }));

		const drawer = screen.getByTestId("comments-drawer");
		expect(drawer).toHaveAttribute("aria-label", "Comments");
		expect(drawer.parentElement).toBe(document.body);
		expect(
			within(drawer).getByText("Anna says the Musikverein sells out early."),
		).toBeInTheDocument();
	});

	it("the drawer closes on Escape and, once torn down, returns focus to whatever opened it", async () => {
		const trigger = document.createElement("button");
		trigger.textContent = "Comments trigger";
		document.body.appendChild(trigger);
		trigger.focus();
		const onClose = vi.fn();

		const result = render(
			CommentsSheet,
			baseProps({ presentation: "drawer", onClose }),
		);
		// Focus-on-open (the drawer's own close button) settles first, so it
		// cannot race the stray-focus check below.
		await waitFor(() => expect(document.activeElement).not.toBe(trigger));

		await fireEvent.keyDown(window, { key: "Escape" });
		expect(onClose).toHaveBeenCalled();

		// `onClose` only asks the parent to remove this component — exactly
		// like `DialogShell`, focus returns to whatever opened it once the
		// parent actually tears it down (`restoreFocusOnCleanup`), which here
		// is simulated the same way `DialogShell.test.ts` does.
		result.unmount();
		await waitFor(() => expect(document.activeElement).toBe(trigger));

		trigger.remove();
	});

	it("the drawer closes via its own close button", async () => {
		const onClose = vi.fn();
		render(CommentsSheet, baseProps({ presentation: "drawer", onClose }));

		await fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(onClose).toHaveBeenCalled();
	});

	it("going to a comment's anchor also closes the overlay, so the flash-scroll it triggers is visible", async () => {
		const onGotoAnchor = vi.fn();
		const onClose = vi.fn();

		render(
			CommentsSheet,
			baseProps({
				presentation: "drawer",
				onClose,
				onGotoAnchor,
				comments: [COMMENT],
				blocks: [BLOCK],
			}),
		);

		const quoteButton = await screen.findByRole("button", {
			name: /one proper concert/,
		});
		await fireEvent.click(quoteButton);

		expect(onGotoAnchor).toHaveBeenCalledWith(
			"p1",
			expect.any(Number),
			expect.any(Number),
		);
		expect(onClose).toHaveBeenCalled();
	});
});
