import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import DocumentToolbar from "./DocumentToolbar.svelte";
import {
	DOCUMENT_TOOLBAR_ACTIONS,
	type DocumentToolbarActionId,
} from "./toolbar-actions";

describe("DocumentToolbar", () => {
	afterEach(() => {
		cleanup();
	});

	it("renders one button per action, in a toolbar labelled 'Document'", () => {
		render(DocumentToolbar, { onAction: vi.fn() });

		// The toolbar's own aria-label names the type in words ("Document"),
		// never "Artifact" (ADR-0066) — the dictionary-wide audit in
		// artifacts.test.ts already guards every VALUE never saying "artifact";
		// this just proves this specific label resolves to the right word.
		const toolbar = screen.getByRole("toolbar", { name: "Document" });
		expect(toolbar).toBeInTheDocument();
		expect(screen.getAllByRole("button")).toHaveLength(
			DOCUMENT_TOOLBAR_ACTIONS.length,
		);
	});

	it("fires onAction with the pressed button's id", async () => {
		const onAction = vi.fn();
		render(DocumentToolbar, { onAction });

		await fireEvent.click(screen.getByRole("button", { name: "Bold" }));
		expect(onAction).toHaveBeenCalledWith("bold");
	});

	it("shows a pressed state for an active, non-momentary action", () => {
		render(DocumentToolbar, {
			onAction: vi.fn(),
			activeActionIds: new Set<DocumentToolbarActionId>(["bold"]),
		});

		expect(screen.getByRole("button", { name: "Bold" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		expect(screen.getByRole("button", { name: "Italic" })).toHaveAttribute(
			"aria-pressed",
			"false",
		);
	});

	it("a momentary action (Undo) never carries a pressed state", () => {
		render(DocumentToolbar, { onAction: vi.fn() });
		expect(screen.getByRole("button", { name: "Undo" })).not.toHaveAttribute(
			"aria-pressed",
		);
	});

	it("disables every button while the editor is not ready", () => {
		render(DocumentToolbar, { onAction: vi.fn(), disabled: true });
		for (const button of screen.getAllByRole("button")) {
			expect(button).toBeDisabled();
		}
	});
});
