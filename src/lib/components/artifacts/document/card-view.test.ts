import { describe, expect, it, vi } from "vitest";
import {
	parseDocument,
	serializeDocument,
} from "$lib/shared/artifact-document/blocks";
import {
	documentArtifactCardView,
	documentArtifactCardViewFromPreview,
	documentCardTabCount,
	documentTabsFromCardMetadata,
} from "./card-view";

function bodyWithTasks(): string {
	const source = [
		"# Packing",
		"",
		"- [x] Passport",
		"",
		"- [x] Tickets",
		"",
		"- [ ] Charger",
		"",
		"- [ ] Sunscreen",
		"",
		"- [ ] Umbrella",
		"",
		"- [ ] Guidebook",
	].join("\n");
	return serializeDocument(parseDocument(source).blocks);
}

describe("card-view: documentTabsFromCardMetadata / documentCardTabCount", () => {
	it("reads a well-formed tabs array", () => {
		const metadata = {
			tabs: [{ id: "t1", title: "Plan", startBlockId: "p1" }],
		};
		expect(documentTabsFromCardMetadata(metadata as never)).toEqual([
			{ id: "t1", title: "Plan", startBlockId: "p1" },
		]);
		expect(documentCardTabCount(metadata as never)).toBe(1);
	});

	it("reads [] for missing or malformed metadata, never throwing", () => {
		expect(documentTabsFromCardMetadata(null)).toEqual([]);
		expect(documentTabsFromCardMetadata(undefined)).toEqual([]);
		expect(documentTabsFromCardMetadata({} as never)).toEqual([]);
		expect(
			documentTabsFromCardMetadata({ tabs: "not-an-array" } as never),
		).toEqual([]);
		expect(
			documentTabsFromCardMetadata({ tabs: [{ id: 1 }] } as never),
		).toEqual([]);
	});
});

describe("card-view: documentArtifactCardView", () => {
	it("has no tickable checklist for a document with no task list", () => {
		const view = documentArtifactCardView({
			artifactId: "doc-1",
			title: "Notes",
			versionNumber: 1,
			body: "Just a paragraph.",
			onToggleTask: vi.fn(),
		});
		expect(view.tickable).toBeNull();
	});

	it("lists every task item with its checked state, in document order", () => {
		const view = documentArtifactCardView({
			artifactId: "doc-1",
			title: "Trip",
			versionNumber: 2,
			body: bodyWithTasks(),
			onToggleTask: vi.fn(),
		});
		expect(view.tickable).not.toBeNull();
		expect(
			view.tickable?.items.map((i) => ({ text: i.text, done: i.done })),
		).toEqual([
			{ text: "Passport", done: true },
			{ text: "Tickets", done: true },
			{ text: "Charger", done: false },
			{ text: "Sunscreen", done: false },
			{ text: "Umbrella", done: false },
			{ text: "Guidebook", done: false },
		]);
	});

	it("ticking an item calls onToggleTask with its block id and the flipped state — through the same patch path (T9.7)", () => {
		const onToggleTask = vi.fn();
		const view = documentArtifactCardView({
			artifactId: "doc-1",
			title: "Trip",
			versionNumber: 2,
			body: bodyWithTasks(),
			onToggleTask,
		});
		const charger = view.tickable?.items.find((i) => i.text === "Charger");
		expect(charger).toBeTruthy();
		view.tickable?.onToggle(charger?.id ?? "");
		expect(onToggleTask).toHaveBeenCalledExactlyOnceWith(charger?.id, true);

		const passport = view.tickable?.items.find((i) => i.text === "Passport");
		view.tickable?.onToggle(passport?.id ?? "");
		expect(onToggleTask).toHaveBeenCalledWith(passport?.id, false);
	});

	it("carries the already-localised subtitle and madeBy through verbatim", () => {
		const view = documentArtifactCardView({
			artifactId: "doc-1",
			title: "Trip",
			versionNumber: 1,
			subtitle: "Document · 3 tabs",
			madeBy: "made by Alfy just now",
			body: null,
			onToggleTask: vi.fn(),
		});
		expect(view.subtitle).toBe("Document · 3 tabs");
		expect(view.madeBy).toBe("made by Alfy just now");
		expect(view.kind).toBe("document");
		expect(view.openTargetId).toBe("doc-1");
	});
});

describe("card-view: documentArtifactCardViewFromPreview (the chat card's bounded builder, T9 steps 4/7)", () => {
	it("builds the SAME shape as the full-body view, from the bounded preview alone", () => {
		const view = documentArtifactCardViewFromPreview({
			artifactId: "doc-1",
			title: "Packing list",
			versionNumber: 2,
			subtitle: "Document · 1 tab",
			preview: {
				tabCount: 1,
				tasks: [
					{ blockId: "b1", text: "Passport", checked: true },
					{ blockId: "b2", text: "Charger", checked: false },
				],
				totalTaskCount: 2,
			},
			onToggleTask: vi.fn(),
		});

		expect(view).toMatchObject({
			id: "doc-1",
			kind: "document",
			title: "Packing list",
			subtitle: "Document · 1 tab",
			versionNumber: 2,
			openTargetId: "doc-1",
		});
		expect(view.tickable?.items).toEqual([
			{ id: "b1", text: "Passport", done: true },
			{ id: "b2", text: "Charger", done: false },
		]);
	});

	it("shows the true total even though the preview only ever carries five", () => {
		const view = documentArtifactCardViewFromPreview({
			artifactId: "doc-1",
			title: "Packing list",
			versionNumber: 1,
			preview: {
				tabCount: 1,
				tasks: [
					{ blockId: "b1", text: "Passport", checked: true },
					{ blockId: "b2", text: "Tickets", checked: true },
					{ blockId: "b3", text: "Charger", checked: false },
					{ blockId: "b4", text: "Sunscreen", checked: false },
					{ blockId: "b5", text: "Umbrella", checked: false },
				],
				totalTaskCount: 7,
			},
			onToggleTask: vi.fn(),
		});

		expect(view.tickable?.items).toHaveLength(5);
		expect(view.tickable?.totalCount).toBe(7);
	});

	it("has no tickable checklist when the preview's checklist is empty", () => {
		const view = documentArtifactCardViewFromPreview({
			artifactId: "doc-1",
			title: "Notes",
			versionNumber: 1,
			preview: { tabCount: 1, tasks: [], totalTaskCount: 0 },
			onToggleTask: vi.fn(),
		});
		expect(view.tickable).toBeNull();
	});

	it("ticking calls onToggleTask with the block id and the flipped state", () => {
		const onToggleTask = vi.fn();
		const view = documentArtifactCardViewFromPreview({
			artifactId: "doc-1",
			title: "Packing list",
			versionNumber: 1,
			preview: {
				tabCount: 1,
				tasks: [{ blockId: "b1", text: "Passport", checked: false }],
				totalTaskCount: 1,
			},
			onToggleTask,
		});
		view.tickable?.onToggle("b1");
		expect(onToggleTask).toHaveBeenCalledExactlyOnceWith("b1", true);
	});
});
