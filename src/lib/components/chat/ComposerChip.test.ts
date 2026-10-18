import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import ComposerChip from "./ComposerChip.svelte";
import {
	COMPOSER_CHIP_KINDS,
	COMPOSER_CHIP_ROW_CONTEXT,
	composerChipTint,
	composerChipUsesThumbnail,
} from "./composer-chip-kinds";

// The chip grammar (owner-approved boards, 2026-09-15). What is pinned here
// is the part of the redesign that is a PROMISE rather than a drawing: the
// tint scheme, the two sizes, which chips are removable, the meta that
// truncates before the label, and the thumbnail that falls back rather than
// leaving a broken image in the pill.

describe("composerChipTint — two tints, not eight", () => {
	it("tints only the two kinds that change how the turn RUNS", () => {
		expect(composerChipTint("skill")).toBe("accent");
		expect(composerChipTint("atlas")).toBe("warning");
	});

	// The owner's amendment to the board: web search is rare now that only an
	// explicit /web sets it, so it is material like an attachment. If this
	// flips back to a tint, it is a decision, not a drive-by.
	it("leaves web search neutral, like everything else you attach or quote", () => {
		for (const kind of [
			"web",
			"file",
			"image",
			"quote",
			"library",
			"queued",
		] as const) {
			expect(composerChipTint(kind), kind).toBe("neutral");
		}
	});

	it("is exhaustive over the closed kind enum", () => {
		for (const kind of COMPOSER_CHIP_KINDS) {
			expect(["accent", "warning", "neutral"]).toContain(
				composerChipTint(kind),
			);
		}
	});
});

describe("composerChipUsesThumbnail", () => {
	it("is true only for an image that actually has a source", () => {
		expect(composerChipUsesThumbnail("image", "/api/knowledge/a/preview")).toBe(
			true,
		);
		expect(composerChipUsesThumbnail("image", null)).toBe(false);
		expect(composerChipUsesThumbnail("file", "/api/knowledge/a/preview")).toBe(
			false,
		);
	});
});

describe("ComposerChip", () => {
	it("carries its kind and tint on the pill so a state can be asserted", () => {
		const { getByTestId } = render(ComposerChip, {
			props: { kind: "skill", label: "Invoice reply", testId: "chip" },
		});
		const chip = getByTestId("chip");
		expect(chip.dataset.chipKind).toBe("skill");
		expect(chip.dataset.chipTint).toBe("accent");
		expect(chip.dataset.chipSize).toBe("composer");
		expect(chip.textContent).toContain("Invoice reply");
	});

	it("puts the profile in the meta clause, after a middle dot", () => {
		const { getByTestId } = render(ComposerChip, {
			props: {
				kind: "atlas",
				label: "Atlas",
				meta: "In-Depth · ~10-20 min",
				testId: "chip",
			},
		});
		expect(getByTestId("composer-chip-meta").textContent).toBe(
			"· In-Depth · ~10-20 min",
		);
	});

	// Truncation is a layout property jsdom does not compute, so what a unit
	// test can honestly pin is the RULE that buys it: the meta's shrink factor
	// is twenty times the label's, so the meta gives up its width first and a
	// skill's own name is the last thing to disappear. Asserted against the
	// component's <style> block, the way the hover and reduced-motion
	// regressions assert theirs.
	it("lets the meta shrink twenty times faster than the label", () => {
		const { getByTestId } = render(ComposerChip, {
			props: {
				kind: "file",
				label: "Lease agreement 2026.pdf",
				meta: "24 pp · 18k tok",
				testId: "chip",
			},
		});
		const chip = getByTestId("chip");
		expect(chip.querySelector(".composer-chip__label")).not.toBeNull();
		expect(chip.querySelector(".composer-chip__meta")).not.toBeNull();

		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "ComposerChip.svelte"),
			"utf-8",
		);
		const labelRule = source.slice(source.indexOf(".composer-chip__label {"));
		const metaRule = source.slice(source.indexOf(".composer-chip__meta {"));
		expect(labelRule.slice(0, 200)).toContain("flex: 0 1 auto");
		expect(metaRule.slice(0, 200)).toContain("flex: 0 20 auto");
	});

	it("drops the meta entirely when the turn knows nothing to say", () => {
		const { queryByTestId } = render(ComposerChip, {
			props: { kind: "web", label: "Web search", testId: "chip" },
		});
		expect(queryByTestId("composer-chip-meta")).toBeNull();
	});

	it("has no remove control until it is asked for one", () => {
		const { getByTestId, queryByRole } = render(ComposerChip, {
			props: { kind: "quote", label: "2.3 Break clause", testId: "chip" },
		});
		expect(getByTestId("chip")).toBeDefined();
		expect(queryByRole("button")).toBeNull();
	});

	it("removes on click and on Delete/Backspace from its one focus stop", async () => {
		const onRemove = vi.fn();
		const { getByRole } = render(ComposerChip, {
			props: {
				kind: "skill",
				label: "Invoice reply",
				removable: true,
				removeLabel: "Remove pending skill Invoice reply",
				onRemove,
			},
		});
		const remove = getByRole("button", {
			name: "Remove pending skill Invoice reply",
		});
		await fireEvent.click(remove);
		expect(onRemove).toHaveBeenCalledTimes(1);

		await fireEvent.keyDown(remove, { key: "Delete" });
		expect(onRemove).toHaveBeenCalledTimes(2);
		await fireEvent.keyDown(remove, { key: "Backspace" });
		expect(onRemove).toHaveBeenCalledTimes(3);
		// Any other key is the textarea's business, not the chip's.
		await fireEvent.keyDown(remove, { key: "a" });
		expect(onRemove).toHaveBeenCalledTimes(3);
	});

	// The × under the caret is about to leave the DOM. With no neighbouring
	// chip to take focus, the row's fallback (the composer's textarea) does —
	// never <body>, which would strand a keyboard user at the top of the page.
	it("hands focus to the row's fallback when Delete removes the last chip", async () => {
		const onRemove = vi.fn();
		const focusFallback = vi.fn();
		const { getByRole } = render(ComposerChip, {
			props: {
				kind: "quote",
				label: "2.3 Break clause",
				removable: true,
				removeLabel: "Remove quote 2.3 Break clause",
				onRemove,
			},
			context: new Map([[COMPOSER_CHIP_ROW_CONTEXT, { focusFallback }]]),
		});
		const remove = getByRole("button", {
			name: "Remove quote 2.3 Break clause",
		});
		remove.focus();
		await fireEvent.keyDown(remove, { key: "Delete" });
		expect(onRemove).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(focusFallback).toHaveBeenCalledTimes(1));
	});

	// Enter/Space on a focused × arrives as a click, and so does a pointer
	// click; either way the button that had focus is removed. Falling back to
	// <body> would strand a keyboard or switch user at the top of the page.
	it("hands focus on when the X is activated, not only on Delete", async () => {
		const onRemove = vi.fn();
		const focusFallback = vi.fn();
		const { getByRole } = render(ComposerChip, {
			props: {
				kind: "quote",
				label: "2.3 Break clause",
				removable: true,
				removeLabel: "Remove quote 2.3 Break clause",
				onRemove,
			},
			context: new Map([[COMPOSER_CHIP_ROW_CONTEXT, { focusFallback }]]),
		});
		const remove = getByRole("button", {
			name: "Remove quote 2.3 Break clause",
		});
		remove.focus();
		await fireEvent.click(remove);
		expect(onRemove).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(focusFallback).toHaveBeenCalledTimes(1));
	});

	it("does not remove while disabled", async () => {
		const onRemove = vi.fn();
		const { getByRole } = render(ComposerChip, {
			props: {
				kind: "skill",
				label: "Invoice reply",
				removable: true,
				removeLabel: "Remove Invoice reply",
				disabled: true,
				onRemove,
			},
		});
		await fireEvent.click(
			getByRole("button", { name: "Remove Invoice reply" }),
		);
		expect(onRemove).not.toHaveBeenCalled();
	});

	it("shows an image attachment's own crop as its leading mark", () => {
		const { getByTestId } = render(ComposerChip, {
			props: {
				kind: "image",
				label: "floor-plan-level-2.png",
				thumbnailUrl: "/api/knowledge/artifact-1/preview",
				testId: "chip",
			},
		});
		const thumb = getByTestId("chip").querySelector(
			"img.composer-chip__thumb",
		) as HTMLImageElement | null;
		expect(thumb).not.toBeNull();
		expect(thumb?.getAttribute("src")).toBe(
			"/api/knowledge/artifact-1/preview",
		);
	});

	// A revoked object URL or a 404 preview must not leave a broken-image box
	// inside the pill.
	it("falls back to the stroke icon when the thumbnail cannot load", async () => {
		const { getByTestId } = render(ComposerChip, {
			props: {
				kind: "image",
				label: "floor-plan-level-2.png",
				thumbnailUrl: "/api/knowledge/missing/preview",
				testId: "chip",
			},
		});
		const chip = getByTestId("chip");
		const thumb = chip.querySelector("img.composer-chip__thumb");
		expect(thumb).not.toBeNull();

		await fireEvent.error(thumb as HTMLImageElement);

		expect(chip.querySelector("img.composer-chip__thumb")).toBeNull();
		expect(chip.querySelector(".composer-chip__icon")).not.toBeNull();
	});

	it("falls back immediately when an image has no resolvable source", () => {
		const { getByTestId } = render(ComposerChip, {
			props: { kind: "image", label: "pasted.png", testId: "chip" },
		});
		const chip = getByTestId("chip");
		expect(chip.querySelector("img.composer-chip__thumb")).toBeNull();
		expect(chip.querySelector(".composer-chip__icon")).not.toBeNull();
	});

	it("shrinks to the in-message size and refuses a remove control there", () => {
		const { getByTestId, queryByRole } = render(ComposerChip, {
			props: {
				kind: "file",
				label: "Lease agreement 2026.pdf",
				size: "message",
				testId: "chip",
			},
		});
		const chip = getByTestId("chip");
		expect(chip.dataset.chipSize).toBe("message");
		expect(chip.className).toContain("composer-chip--message");
		expect(queryByRole("button")).toBeNull();
	});

	it("makes the body a button — and only the body — when it can be opened", async () => {
		const onActivate = vi.fn();
		const { getByRole } = render(ComposerChip, {
			props: {
				kind: "file",
				label: "Lease agreement 2026.pdf",
				size: "message",
				onActivate,
				activateLabel: "Open Lease agreement 2026.pdf",
			},
		});
		await fireEvent.click(
			getByRole("button", { name: "Open Lease agreement 2026.pdf" }),
		);
		expect(onActivate).toHaveBeenCalledTimes(1);
	});

	it("shows an unavailable skill's status without losing its name", () => {
		const { getByTestId } = render(ComposerChip, {
			props: {
				kind: "skill",
				label: "Invoice reply",
				status: "Unavailable",
				testId: "chip",
			},
		});
		const chip = getByTestId("chip");
		expect(chip.textContent).toContain("Invoice reply");
		expect(chip.textContent).toContain("Unavailable");
	});

	// A file that is still being uploaded or read has no removal control yet:
	// the composer's send gate is holding the turn, and the control slot where
	// the × will appear wears a spinner instead. `aria-busy` plus the echoed
	// label is what a screen reader hears in place of the removed button.
	it("puts a spinner in the remove control's place while busy", () => {
		const { getByTestId, queryByRole } = render(ComposerChip, {
			props: {
				kind: "file",
				label: "scan.pdf",
				meta: "Uploading…",
				removable: true,
				removeLabel: "Remove scan.pdf",
				onRemove: vi.fn(),
				busy: true,
				busyLabel: "Uploading scan.pdf",
				testId: "chip",
			},
		});
		const chip = getByTestId("chip");
		expect(chip).toHaveAttribute("aria-busy", "true");
		expect(getByTestId("composer-chip-busy")).toBeInTheDocument();
		expect(queryByRole("button")).toBeNull();
		expect(chip).toHaveTextContent("Uploading scan.pdf");
	});

	it("gives the X back, and drops the busy label, once the work is done", () => {
		const { getByTestId, getByRole, queryByTestId } = render(ComposerChip, {
			props: {
				kind: "file",
				label: "scan.pdf",
				removable: true,
				removeLabel: "Remove scan.pdf",
				onRemove: vi.fn(),
				busy: false,
				busyLabel: "Uploading scan.pdf",
				testId: "chip",
			},
		});
		const chip = getByTestId("chip");
		expect(chip).not.toHaveAttribute("aria-busy", "true");
		expect(queryByTestId("composer-chip-busy")).toBeNull();
		expect(
			getByRole("button", { name: "Remove scan.pdf" }),
		).toBeInTheDocument();
	});

	// Pressing Retry on a failed chip requeues the job, which removes both the
	// Retry button and the X. A keyboard user must not be left on <body>: the
	// chip itself is a programmatic focus stop (not a tab stop) while busy.
	it("is a stable programmatic focus stop while its control slot is a spinner", () => {
		const { getByTestId } = render(ComposerChip, {
			props: {
				kind: "file",
				label: "scan.pdf",
				removable: true,
				removeLabel: "Remove scan.pdf",
				onRemove: vi.fn(),
				busy: true,
				testId: "chip",
			},
		});
		const chip = getByTestId("chip");
		expect(chip).toHaveAttribute("tabindex", "-1");
		chip.focus();
		expect(document.activeElement).toBe(chip);
	});

	// The × is the only focus stop on a chip, so the open failure popover has
	// to describe THAT — a described-by on a non-focusable wrapper would never
	// be heard.
	it("describes the X with the open failure details", () => {
		const { getByRole } = render(ComposerChip, {
			props: {
				kind: "file",
				label: "scan.pdf",
				removable: true,
				removeLabel: "Remove scan.pdf",
				onRemove: vi.fn(),
				detailsId: "composer-chip-failure-details-1",
			},
		});
		expect(getByRole("button", { name: "Remove scan.pdf" })).toHaveAttribute(
			"aria-describedby",
			"composer-chip-failure-details-1",
		);
	});

	// The busy loader is the shared Spinner, not a hand-rolled chip animation:
	// the chip's motion guard (reduced-motion-transitions.regression.test.ts)
	// forbids @keyframes/animation: in this file, and the global reduced-motion
	// reset reaches Spinner's `animate-spin`.
	it("renders the shared Spinner in the busy slot, with no animation of its own", () => {
		const { getByTestId } = render(ComposerChip, {
			props: {
				kind: "file",
				label: "scan.pdf",
				removable: true,
				removeLabel: "Remove scan.pdf",
				onRemove: vi.fn(),
				busy: true,
				testId: "chip",
			},
		});
		expect(
			getByTestId("chip").querySelector('[data-testid="spinner"]'),
		).not.toBeNull();

		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "ComposerChip.svelte"),
			"utf-8",
		);
		expect(source).toContain('from "../ui/Spinner.svelte"');
		expect(source).not.toContain("@keyframes");
		expect(source).not.toMatch(/\n\s*animation:/);
	});
});
