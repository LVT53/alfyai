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

	it("never renders Download or History (both moved to the panel header)", () => {
		render(DocumentToolbar, { onAction: vi.fn() });
		expect(
			screen.queryByRole("button", { name: "Download" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "History" }),
		).not.toBeInTheDocument();
	});

	it("groups actions with dividers, one fewer divider than the number of groups", () => {
		const { container } = render(DocumentToolbar, { onAction: vi.fn() });
		const groupCount = new Set(DOCUMENT_TOOLBAR_ACTIONS.map((a) => a.group))
			.size;
		expect(
			container.querySelectorAll(".document-toolbar-divider"),
		).toHaveLength(groupCount - 1);
	});

	describe("roving tabindex (WAI-ARIA toolbar pattern)", () => {
		it("only the first button starts in the tab order", () => {
			render(DocumentToolbar, { onAction: vi.fn() });
			const buttons = screen.getAllByRole("button");
			expect(buttons[0]).toHaveAttribute("tabindex", "0");
			for (const button of buttons.slice(1)) {
				expect(button).toHaveAttribute("tabindex", "-1");
			}
		});

		it("ArrowRight/ArrowLeft move the roving tab stop and focus, wrapping at both ends", async () => {
			render(DocumentToolbar, { onAction: vi.fn() });
			const toolbar = screen.getByRole("toolbar");
			const buttons = screen.getAllByRole("button");

			await fireEvent.keyDown(toolbar, { key: "ArrowLeft" });
			expect(buttons[buttons.length - 1]).toHaveFocus();
			expect(buttons[buttons.length - 1]).toHaveAttribute("tabindex", "0");

			await fireEvent.keyDown(toolbar, { key: "ArrowRight" });
			expect(buttons[0]).toHaveFocus();
		});

		it("Home/End jump to the first/last button", async () => {
			render(DocumentToolbar, { onAction: vi.fn() });
			const toolbar = screen.getByRole("toolbar");
			const buttons = screen.getAllByRole("button");

			await fireEvent.keyDown(toolbar, { key: "End" });
			expect(buttons[buttons.length - 1]).toHaveFocus();

			await fireEvent.keyDown(toolbar, { key: "Home" });
			expect(buttons[0]).toHaveFocus();
		});

		it("clicking a button makes it the roving tab stop", async () => {
			render(DocumentToolbar, { onAction: vi.fn() });
			const italic = screen.getByRole("button", { name: "Italic" });
			await fireEvent.click(italic);
			expect(italic).toHaveAttribute("tabindex", "0");
			expect(screen.getByRole("button", { name: "Bold" })).toHaveAttribute(
				"tabindex",
				"-1",
			);
		});
	});

	describe("the save state (redesign §5.2/§9.2)", () => {
		it("renders nothing when saveState is not given", () => {
			const { container } = render(DocumentToolbar, { onAction: vi.fn() });
			expect(
				container.querySelector(".document-toolbar-save-state"),
			).toBeNull();
		});

		it("shows 'Saved' for the saved state", () => {
			render(DocumentToolbar, { onAction: vi.fn(), saveState: "saved" });
			expect(screen.getByRole("status")).toHaveTextContent("Saved");
		});

		it("shows 'Saving…' while dirty", () => {
			render(DocumentToolbar, { onAction: vi.fn(), saveState: "saving" });
			expect(screen.getByRole("status")).toHaveTextContent("Saving…");
		});

		it("shows 'Offline' and 'Conflict' for their own states", () => {
			const { rerender } = render(DocumentToolbar, {
				onAction: vi.fn(),
				saveState: "offline",
			});
			expect(screen.getByRole("status")).toHaveTextContent("Offline");

			rerender({ onAction: vi.fn(), saveState: "conflict" });
			expect(screen.getByRole("status")).toHaveTextContent("Conflict");
		});
	});
});
