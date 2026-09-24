import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import type { InstructionScope } from "$lib/shared/instructions";
import InstructionsDialog from "./InstructionsDialog.svelte";

const personal: InstructionScope = { kind: "personal" };
const project: InstructionScope = {
	kind: "project",
	projectId: "p1",
	name: "Vienna trip",
};

type SaveResult = { ok: true } | { ok: false; error: string };

interface OpenOptions {
	open?: boolean;
	scope?: InstructionScope;
	scopes?: InstructionScope[];
	initialText?: Record<string, string>;
	appendedLine?: string | null;
	appendedScope?: InstructionScope;
}

function open(options: OpenOptions = {}) {
	const onSave = vi.fn(async (): Promise<SaveResult> => ({ ok: true }));
	const onClose = vi.fn();

	const rendered = render(InstructionsDialog, {
		props: {
			open: options.open ?? true,
			scope: options.scope ?? personal,
			scopes: options.scopes ?? [personal],
			initialText: options.initialText ?? {},
			appendedLine: options.appendedLine ?? null,
			appendedScope: options.appendedScope,
			onSave,
			onClose,
		},
	});

	return { rendered, onSave, onClose };
}

const textbox = (name = "Instructions for Personal") =>
	screen.findByRole("textbox", { name });

const counter = () => screen.getByTestId("instructions-counter");

// The dialog portals to document.body (DialogShell), so the mirror is not
// inside the render container.
const mirrorMark = () => document.querySelector(".instructions-mirror mark");

describe("InstructionsDialog", () => {
	it("renders one textarea and the live counter for the opened scope", async () => {
		open({ initialText: { personal: "Answer briefly." } });

		expect(await textbox()).toHaveValue("Answer briefly.");
		expect(screen.getAllByRole("textbox")).toHaveLength(1);
		expect(counter()).toHaveTextContent("15 / 2000");
	});

	it("renders nothing while closed", () => {
		open({ open: false });

		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
	});

	it("appends the pending line to the buffer and grows the counter to include it", async () => {
		open({
			initialText: { personal: "Answer briefly." },
			appendedLine: "Use metric units.",
			appendedScope: personal,
		});

		expect(await textbox()).toHaveValue("Answer briefly.\nUse metric units.");
		expect(counter()).toHaveTextContent("33 / 2000");
		// Highlighted where it will live, not described in prose.
		expect(mirrorMark()).toHaveTextContent("Use metric units.");
		expect(screen.getByText(/Added to the end/)).toBeInTheDocument();
	});

	it("disables Save and shows tooLong when the buffer passes the limit", async () => {
		open();
		const box = await textbox();

		await fireEvent.input(box, { target: { value: "a".repeat(2001) } });

		expect(counter()).toHaveTextContent("2001 / 2000");
		expect(screen.getByTestId("instructions-too-long")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
		// Over the limit is refused, never trimmed to fit.
		expect(box).toHaveValue("a".repeat(2001));
	});

	it("counts the buffer in code points, so accents and emoji agree with the server", async () => {
		open({ initialText: { personal: "árvíztűrő" } });
		const box = await textbox();

		expect(counter()).toHaveTextContent("9 / 2000");

		// 1,001 code points but 2,002 UTF-16 units: a counter counting units
		// would refuse a text the server accepts.
		await fireEvent.input(box, { target: { value: "👍".repeat(1001) } });
		expect(counter()).toHaveTextContent("1001 / 2000");
		expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();

		await fireEvent.input(box, { target: { value: "👍".repeat(2001) } });
		expect(counter()).toHaveTextContent("2001 / 2000");
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
	});

	it("counts the trim the server will apply, so trailing spaces cannot promise more than is stored", async () => {
		open();
		const box = await textbox();

		await fireEvent.input(box, {
			target: { value: `${"a".repeat(2000)}   ` },
		});

		expect(counter()).toHaveTextContent("2000 / 2000");
		expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
	});

	it("does not render the scope switch when only one scope is passed", async () => {
		open({ scopes: [personal] });

		await textbox();

		expect(
			screen.queryByTestId("instructions-scope-switch"),
		).not.toBeInTheDocument();
	});

	it("renders the switch with the opened scope selected when there are two", async () => {
		open({ scope: project, scopes: [personal, project] });

		await textbox("Instructions for Vienna trip");

		expect(screen.getByTestId("instructions-scope-switch")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Personal" })).toHaveAttribute(
			"aria-pressed",
			"false",
		);
		expect(screen.getByRole("button", { name: /Vienna trip/ })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
	});

	it("moves the pending line to the other scope's text when the switch is used", async () => {
		const { onSave } = open({
			scope: project,
			scopes: [personal, project],
			initialText: {
				personal: "Answer briefly.",
				"project:p1": "Stay near Westbahnhof.",
			},
			appendedLine: "Only suggest trains, no flights.",
			appendedScope: project,
		});

		expect(await textbox("Instructions for Vienna trip")).toHaveValue(
			"Stay near Westbahnhof.\nOnly suggest trains, no flights.",
		);

		await fireEvent.click(screen.getByRole("button", { name: "Personal" }));

		// The line travels with the user: it is the thing still being decided.
		expect(
			screen.getByRole("textbox", { name: "Instructions for Personal" }),
		).toHaveValue("Answer briefly.\nOnly suggest trains, no flights.");
		expect(mirrorMark()).toHaveTextContent("Only suggest trains, no flights.");

		await fireEvent.click(screen.getByRole("button", { name: /Vienna trip/ }));

		// And back again, without leaving a copy behind.
		expect(
			screen.getByRole("textbox", { name: "Instructions for Vienna trip" }),
		).toHaveValue("Stay near Westbahnhof.\nOnly suggest trains, no flights.");

		await fireEvent.click(screen.getByRole("button", { name: "Save" }));

		// One scope on screen at a time: the switch never saves the other one.
		await waitFor(() =>
			expect(onSave).toHaveBeenCalledWith({
				scope: project,
				text: "Stay near Westbahnhof.\nOnly suggest trains, no flights.",
			}),
		);
	});

	it("keeps the buffer when Save fails and shows the error", async () => {
		const { onSave, onClose } = open({
			initialText: { personal: "Answer briefly." },
		});
		onSave.mockResolvedValueOnce({
			ok: false,
			error: "Instructions are too long",
		});
		const box = await textbox();

		await fireEvent.input(box, {
			target: { value: "Answer briefly. No emoji." },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(screen.getByTestId("instructions-error")).toHaveTextContent(
				"Instructions are too long",
			),
		);
		expect(box).toHaveValue("Answer briefly. No emoji.");
		expect(onClose).not.toHaveBeenCalled();
	});

	it("calls onClose without onSave when Cancel is pressed", async () => {
		const { onSave, onClose } = open({
			initialText: { personal: "Answer briefly." },
		});

		await textbox();
		await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		expect(onClose).toHaveBeenCalledTimes(1);
		expect(onSave).not.toHaveBeenCalled();
	});

	it("sends an empty string when the user deletes the whole text", async () => {
		const { onSave } = open({ initialText: { personal: "Answer briefly." } });
		const box = await textbox();

		await fireEvent.input(box, { target: { value: "" } });
		await fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(onSave).toHaveBeenCalledWith({ scope: personal, text: "" }),
		);
	});

	// The parent keeps this component mounted and drives it with `open`, so
	// Cancel is a close, not an unmount. The abandoned edit must not come back
	// with the sheet: the seed is the stored text, built again on every open.
	it("drops an abandoned edit when the dialog is closed and reopened in place", async () => {
		const { rendered } = open({
			initialText: { personal: "Answer briefly." },
		});
		const box = await textbox();

		await fireEvent.input(box, { target: { value: "Half-written idea." } });

		await rendered.rerender({ open: false });
		await rendered.rerender({ open: true });

		expect(await textbox()).toHaveValue("Answer briefly.");
	});

	// Reopening after a save reads the parent's *current* text, not the copy
	// that was on screen when the component first mounted. The settings page
	// stores what it will show through `normalizeInstructionText`, so the text
	// it hands back is the trimmed one — and that is what the box must show.
	it("re-seeds from the parent's current text when reopened after a save", async () => {
		const { rendered } = open({
			initialText: { personal: "Answer briefly." },
		});
		const box = await textbox();

		await fireEvent.input(box, {
			target: { value: "Answer briefly. No emoji.   " },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(
				screen.queryByTestId("instructions-error"),
			).not.toBeInTheDocument(),
		);

		// What the settings page does on success: close the sheet, then hold the
		// text the server just accepted.
		await rendered.rerender({
			open: false,
			initialText: { personal: "Answer briefly. No emoji." },
		});
		await rendered.rerender({ open: true });

		expect(await textbox()).toHaveValue("Answer briefly. No emoji.");
	});
});
