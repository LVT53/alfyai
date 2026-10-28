import { readFileSync } from "node:fs";
import { render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactKind } from "$lib/shared/artifacts/kinds";
import { at, makeMoment } from "./__fixtures__/moments";
import MomentRail from "./MomentRail.svelte";
import { buildRailGroups } from "./rail-model";

// The rail of History (plan 2b T4): an Image's moments carry a 40 px thumbnail of
// their picture (loaded from the chat's own scope, F25/P13), a Document's none.

const ctx = {
	t: (key: string) => key,
	lang: "en" as const,
	now: at(2026, 10, 27, 12, 0),
};

function renderRail(kind: ArtifactKind, conversationId: string | null) {
	const moments =
		kind === "image"
			? [
					makeMoment({
						versionNumber: 2,
						kind: "alfy_edit",
						author: "alfy",
						at: at(2026, 10, 27, 10, 12),
						isNewest: true,
						containsNewest: true,
						detail: { type: "image", fileId: "file-2", sourceCount: 1 },
					}),
					makeMoment({
						versionNumber: 1,
						kind: "first_draft",
						author: "alfy",
						at: at(2026, 10, 27, 10, 0),
						detail: { type: "image", fileId: "file-1", sourceCount: 0 },
					}),
				]
			: [
					makeMoment({
						versionNumber: 1,
						kind: "first_draft",
						author: "alfy",
						at: at(2026, 10, 27, 10, 0),
						isNewest: true,
						containsNewest: true,
					}),
				];
	return render(MomentRail, {
		groups: buildRailGroups(moments, "all"),
		selectedKey: null,
		ctx: ctx as never,
		artifactKind: kind,
		listLabel: "Versions",
		filter: "all",
		showFilter: false,
		older: false,
		loadingOlder: false,
		conversationId,
		onSelect: vi.fn(),
		onActivate: vi.fn(),
		onFilter: vi.fn(),
		onOlder: vi.fn(),
	});
}

describe("MomentRail thumbnails", () => {
	it("shows a picture's thumbnail on each image moment, from the chat's scope", () => {
		renderRail("image", "conv-1");
		const options = screen.getAllByTestId("history-option");
		expect(options).toHaveLength(2);
		const thumbs = options.map((option) =>
			within(option).getByTestId("history-thumb"),
		);
		const img = thumbs[0].querySelector("img");
		expect(img?.getAttribute("src")).toBe(
			"/api/images/files/file-2?variant=thumb&conversationId=conv-1",
		);
		expect(img?.getAttribute("alt")).toBe("");
		expect(thumbs[1].querySelector("img")?.getAttribute("src")).toContain(
			"/api/images/files/file-1?variant=thumb",
		);
	});

	it("reserves the thumbnail's 40 px square before the picture arrives", () => {
		renderRail("image", null);
		const thumb = screen.getAllByTestId("history-thumb")[0];
		expect(thumb.classList.contains("rail-thumb")).toBe(true);
		expect(thumb.querySelector("[data-testid='image-picture']")).not.toBeNull();
	});

	it("shows none for a Document's moment", () => {
		renderRail("document", "conv-1");
		expect(screen.getAllByTestId("history-option")).toHaveLength(1);
		expect(screen.queryByTestId("history-thumb")).toBeNull();
	});
});

// Task 12 (crowding with the sidebar open): beside the preview the rail is 300 px,
// and an Image row's 40 px picture left its headline ~130 px next to the time, so a
// short line ran to three. A narrow rail (its own width, a container query like the
// card's and the review bar's) puts the time of a picture's row under its headline.
describe("a picture's rail row in a narrow rail", () => {
	const source = readFileSync(
		`${process.cwd()}/src/lib/components/artifacts/history/MomentRail.svelte`,
		"utf-8",
	);

	it("makes the rail list a named inline-size container", () => {
		const list = source.match(/\n\t\.rail-list \{([\s\S]*?)\n\t\}/)?.[1] ?? "";
		expect(list).toMatch(/container:\s*moment-rail\s*\/\s*inline-size/);
	});

	it("moves the time of a row with a picture under its headline when the rail is narrow", () => {
		const block =
			source.match(/@container moment-rail \(max-width: [\d.]+rem\) \{([\s\S]*?)\n\t\}/)?.[1] ??
			"";
		expect(block).toMatch(/\.option\.with-thumb \.line1 \{[^}]*flex-wrap:\s*wrap/);
		expect(block).toMatch(/\.option\.with-thumb \.time \{[^}]*flex-basis:\s*100%/);
		expect(block).toMatch(/var\(--space-/);
	});
});
