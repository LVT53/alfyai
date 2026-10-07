import { fireEvent, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARTIFACT_BODIES } from "$lib/components/artifacts/artifact-bodies";
import {
	deregisterDialog,
	hasOpenDialog,
	isTopmostDialog,
	registerDialog,
} from "$lib/components/ui/DialogShell.svelte";
import { getFocusableElements } from "$lib/utils/focus-trap";
import {
	makeWorkspaceDocument,
	renderWorkspace,
} from "./DocumentWorkspace.test-helpers";

// A host can open the panel above a dialog (a project's Files dialog opens a
// made item in it). The dialog is a layer of the one dialog stack, and a panel
// over it has to be one too, or the dialog under it answers the keys. The
// dialog's own trap is not what these tests are about; a bare entry on the
// stack stands for it, which is all the stack protocol sees of a dialog.

vi.mock("$lib/services/markdown", () => ({
	renderHighlightedText: vi.fn(
		async (content: string) => `<pre><code>${content}</code></pre>`,
	),
}));

const documentItem = () =>
	makeWorkspaceDocument({
		id: "doc-1",
		kind: "document",
		title: "Vienna notes",
		mimeType: null,
		artifactId: "doc-1",
	});

const dialogBelow = Symbol("dialog below the panel");

function openOver(options: { overDialog: boolean; presentation?: "expanded" }) {
	return renderWorkspace({
		documents: [documentItem()],
		activeDocumentId: "doc-1",
		presentation: "expanded",
		returnToDockedOnExpandedClose: false,
		...options,
	});
}

const pressEscape = () => fireEvent.keyDown(window, { key: "Escape" });

describe("DocumentWorkspace over a dialog", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
		global.fetch = vi.fn();
		ARTIFACT_BODIES.document = () =>
			import("./__fixtures__/FakeArtifactBody.svelte");
		registerDialog(dialogBelow);
	});

	afterEach(() => {
		deregisterDialog(dialogBelow);
		delete ARTIFACT_BODIES.document;
	});

	it("is the topmost layer of the stack while it is open, and the dialog is again once it closes", async () => {
		const { rerender } = openOver({ overDialog: true });
		await screen.findByTestId("fake-artifact-body");

		expect(isTopmostDialog(dialogBelow)).toBe(false);

		await rerender({ open: false });
		expect(isTopmostDialog(dialogBelow)).toBe(true);
	});

	it("leaves the stack alone where nothing is beneath it to share it with", async () => {
		deregisterDialog(dialogBelow);
		openOver({ overDialog: false });
		await screen.findByTestId("fake-artifact-body");

		expect(hasOpenDialog()).toBe(false);
		registerDialog(dialogBelow);
	});

	it("closes on one Escape, from the window, and the dialog below is not asked", async () => {
		const { onCloseWorkspace } = openOver({ overDialog: true });
		await screen.findByTestId("fake-artifact-body");

		const notDefaultPrevented = await pressEscape();

		expect(onCloseWorkspace).toHaveBeenCalledTimes(1);
		// The key was taken: nothing after the panel reacts to it as its own.
		expect(notDefaultPrevented).toBe(false);
	});

	it("takes Escape from the Document's editor too, which ProseMirror marks as handled on every press", async () => {
		const { onCloseWorkspace } = openOver({ overDialog: true });
		const body = await screen.findByTestId("fake-artifact-body");
		const editor = document.createElement("div");
		editor.className = "ProseMirror";
		editor.addEventListener("keydown", (event) => event.preventDefault());
		body.append(editor);

		await fireEvent.keyDown(editor, { key: "Escape" });

		expect(onCloseWorkspace).toHaveBeenCalledTimes(1);
	});

	it("leaves an Escape another layer inside the panel already used for itself to that layer", async () => {
		const { onCloseWorkspace } = openOver({ overDialog: true });
		const body = await screen.findByTestId("fake-artifact-body");
		const field = document.createElement("input");
		field.addEventListener("keydown", (event) => event.preventDefault());
		body.append(field);

		await fireEvent.keyDown(field, { key: "Escape" });

		expect(onCloseWorkspace).not.toHaveBeenCalled();
	});

	it("leaves Escape to a layer opened above it (a popover on the stack)", async () => {
		const { onCloseWorkspace } = openOver({ overDialog: true });
		await screen.findByTestId("fake-artifact-body");
		const popover = Symbol("popover above the panel");
		registerDialog(popover);

		await pressEscape();
		expect(onCloseWorkspace).not.toHaveBeenCalled();

		deregisterDialog(popover);
		await pressEscape();
		expect(onCloseWorkspace).toHaveBeenCalledTimes(1);
	});

	it("wraps Tab and Shift+Tab inside the panel, never out to what is beneath", async () => {
		openOver({ overDialog: true });
		await screen.findByTestId("fake-artifact-body");
		const stops = getFocusableElements(screen.getByRole("complementary"));
		expect(stops.length).toBeGreaterThan(1);
		const first = stops[0];
		const last = stops[stops.length - 1];

		last.focus();
		await fireEvent.keyDown(last, { key: "Tab" });
		expect(document.activeElement).toBe(first);

		await fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
		expect(document.activeElement).toBe(last);
	});

	it("does not trap the keys of a panel that is not over a dialog", async () => {
		deregisterDialog(dialogBelow);
		const { onCloseWorkspace } = openOver({ overDialog: false });
		await screen.findByTestId("fake-artifact-body");
		const stops = getFocusableElements(screen.getByRole("complementary"));
		const last = stops[stops.length - 1];
		last.focus();

		const notDefaultPrevented = await fireEvent.keyDown(last, { key: "Tab" });

		expect(notDefaultPrevented, "Tab is the browser's own").toBe(true);
		// Escape is the window handler's, as it always was.
		await pressEscape();
		expect(onCloseWorkspace).toHaveBeenCalledTimes(1);
		registerDialog(dialogBelow);
	});
});
