import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression guard for Task 7 / C1 ("Visible Save/Add buttons in Knowledge").
//
// `--bg-primary` resolves to `#fafaf8` in light mode, the same value as the
// page background, so a `bg-primary text-white` icon button is effectively
// invisible (~1.02:1 contrast). The fix swaps the primary Save/Add icon
// button on each of these three files over to the accent CTA color, matching
// the canonical `.memory-review-accept` pattern already in
// `KnowledgeMemoryView.svelte` (`background: var(--accent); color:
// var(--accent-contrast)`).
//
// These components render inside dialogs/state that are non-trivial to spin
// up (e.g. the review-edit dialog in KnowledgeMemoryView is gated behind
// `editingReviewItem`), so this guard asserts directly against source text
// rather than a full component render — it still fails hard the moment
// `bg-primary` creeps back in, or `bg-accent` is dropped from the button.

const componentsDir = dirname(fileURLToPath(import.meta.url));

function readComponent(fileName: string): string {
	return readFileSync(join(componentsDir, fileName), "utf-8");
}

describe("Save/Add icon button uses the accent CTA color (not bg-primary)", () => {
	it("KnowledgeMemoryModal.svelte: save button carries bg-accent, never bg-primary", () => {
		const source = readComponent("KnowledgeMemoryModal.svelte");

		expect(source).not.toContain("bg-primary");
		expect(source).toContain(
			'class="btn-icon inline-flex h-11 w-11 cursor-pointer items-center justify-center rounded-full bg-accent text-white disabled:cursor-not-allowed disabled:opacity-50"',
		);
	});

	it("PersonaSummaryCard.svelte: save button carries bg-accent, never bg-primary", () => {
		const source = readComponent("PersonaSummaryCard.svelte");

		expect(source).not.toContain("bg-primary");
		expect(source).toContain(
			'class="btn-icon h-11 w-11 cursor-pointer rounded-full bg-accent text-white disabled:cursor-not-allowed disabled:opacity-50"',
		);
	});

	it("KnowledgeMemoryView.svelte: review-edit save button carries bg-accent, never bg-primary", () => {
		const source = readComponent("KnowledgeMemoryView.svelte");

		expect(source).not.toContain("bg-primary");
		expect(source).toContain(
			'class="btn-icon h-11 w-11 cursor-pointer rounded-full bg-accent text-white disabled:cursor-not-allowed disabled:opacity-50"',
		);
	});
});
