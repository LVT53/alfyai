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

/** The side pane; a phone's overlay is its twin in the markup and the stylesheet shows one of the two. */
const desktopShell = () =>
	document.querySelector<HTMLElement>("aside.workspace-shell-desktop") ??
	(() => {
		throw new Error("the desktop shell is not mounted");
	})();

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
		const stops = getFocusableElements(desktopShell());
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

describe("DocumentWorkspace over a dialog: a press outside the panel", () => {
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

	// The same rule as Escape: one press closes the layer that is on top and no
	// other. The dialog under the panel is not asked at all (its own scrim
	// ignores a click whose press began while the panel was above it).
	it("closes the panel when it is the topmost layer", async () => {
		const { onCloseWorkspace } = openOver({ overDialog: true });
		await screen.findByTestId("fake-artifact-body");

		await fireEvent.pointerDown(document.body);

		expect(onCloseWorkspace).toHaveBeenCalledTimes(1);
	});

	it("leaves the press to a layer opened above it (a popover on the stack), and answers the next one", async () => {
		const { onCloseWorkspace } = openOver({ overDialog: true });
		await screen.findByTestId("fake-artifact-body");
		const popover = Symbol("popover above the panel");
		registerDialog(popover);

		// Outside the panel's markup and on the popover's own, which is painted
		// outside it: both are the popover's press.
		await fireEvent.pointerDown(document.body);
		expect(onCloseWorkspace).not.toHaveBeenCalled();

		deregisterDialog(popover);
		await fireEvent.pointerDown(document.body);
		expect(onCloseWorkspace).toHaveBeenCalledTimes(1);
	});

	it("does not close on a press inside itself", async () => {
		const { onCloseWorkspace } = openOver({ overDialog: true });
		const body = await screen.findByTestId("fake-artifact-body");

		await fireEvent.pointerDown(body);

		expect(onCloseWorkspace).not.toHaveBeenCalled();
	});

	it("is unchanged for a panel that is not over a dialog: it closes on the press as it always did", async () => {
		deregisterDialog(dialogBelow);
		const { onCloseWorkspace } = openOver({ overDialog: false });
		await screen.findByTestId("fake-artifact-body");

		await fireEvent.pointerDown(document.body);

		expect(onCloseWorkspace).toHaveBeenCalledTimes(1);
		registerDialog(dialogBelow);
	});
});

describe("DocumentWorkspace over a dialog: what assistive technology is told", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
		global.fetch = vi.fn();
		ARTIFACT_BODIES.document = () =>
			import("./__fixtures__/FakeArtifactBody.svelte");
	});

	afterEach(() => {
		delete ARTIFACT_BODIES.document;
	});

	// The panel stays where its page put it, so it is not later in the document
	// than the dialog under it (a dialog is moved to the end of <body>): it says
	// itself that it is the modal layer, in both of its shells.
	it("is a modal dialog named for what it shows, in the side pane and on a phone", async () => {
		openOver({ overDialog: true });
		await screen.findByTestId("fake-artifact-body");

		const shells = screen.getAllByRole("dialog", {
			name: "Vienna notes, Document",
		});
		expect(shells.map((shell) => shell.tagName).sort()).toEqual([
			"ASIDE",
			"SECTION",
		]);
		for (const shell of shells) {
			expect(shell.getAttribute("aria-modal")).toBe("true");
		}
	});

	it("stays a landmark of its page where it is not over a dialog", async () => {
		openOver({ overDialog: false });
		await screen.findByTestId("fake-artifact-body");

		expect(
			screen.getByRole("complementary", { name: "Vienna notes, Document" }),
		).toBeInTheDocument();
		expect(screen.queryAllByRole("dialog")).toHaveLength(0);
		expect(document.querySelector("[aria-modal]")).toBeNull();
	});
});
