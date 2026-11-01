import { cleanup, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	deregisterDialog,
	registerDialog,
} from "$lib/components/ui/DialogShell.svelte";
import PhotoMarkDialog from "./PhotoMarkDialog.svelte";

function open(onClose = vi.fn()) {
	render(PhotoMarkDialog, {
		artifactId: "photo-1",
		name: "room.jpg",
		marks: [],
		onChange: vi.fn(),
		onClose,
	});
	return onClose;
}

const pressEscape = () =>
	window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

describe("PhotoMarkDialog", () => {
	afterEach(() => {
		cleanup();
		document.body.innerHTML = "";
	});

	it("takes the keyboard from the page behind it", async () => {
		open();

		await waitFor(() =>
			expect(
				screen
					.getByTestId("photo-mark-dialog")
					.contains(document.activeElement),
			).toBe(true),
		);
	});

	it("gives the keyboard back to the tile that opened it", async () => {
		const tile = document.createElement("button");
		document.body.append(tile);
		tile.focus();

		open();
		await waitFor(() => expect(document.activeElement).not.toBe(tile));
		cleanup();

		expect(document.activeElement).toBe(tile);
	});

	it("closes on Escape when it is the top layer", () => {
		const onClose = open();
		pressEscape();
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("leaves Escape to a dialog opened over it", () => {
		const onClose = open();
		const above = Symbol("above");
		registerDialog(above);

		pressEscape();
		deregisterDialog(above);

		expect(onClose).not.toHaveBeenCalled();
	});
});
