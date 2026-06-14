import { describe, expect, it } from "vitest";
import { rankWorkingSetCandidates } from "./working-set";

describe("working-set ranking", () => {
	it("prioritizes newly attached documents and the current generated document", () => {
		const ranked = rankWorkingSetCandidates([
			{
				artifactId: "doc-1",
				artifactType: "source_document",
				name: "Q1 brief",
				summary: null,
				contentText: null,
				updatedAt: Date.now(),
				isAttachedThisTurn: true,
			},
			{
				artifactId: "out-1",
				artifactType: "generated_output",
				name: "Portfolio draft",
				summary: null,
				contentText: null,
				updatedAt: Date.now(),
				isCurrentGeneratedDocument: true,
			},
		]);

		expect(ranked.find((item) => item.artifactId === "doc-1")?.selected).toBe(
			true,
		);
		expect(ranked.find((item) => item.artifactId === "out-1")?.selected).toBe(
			true,
		);
		expect(ranked[0]?.artifactId).toBe("doc-1");
	});

	it("treats the active workspace document as stronger than generic current-document recency", () => {
		const ranked = rankWorkingSetCandidates([
			{
				artifactId: "out-focused",
				artifactType: "generated_output",
				name: "Focused brief",
				summary: null,
				contentText: null,
				updatedAt: Date.now(),
				isActiveDocumentFocus: true,
			},
			{
				artifactId: "out-latest",
				artifactType: "generated_output",
				name: "Current generated document",
				summary: null,
				contentText: null,
				updatedAt: Date.now(),
				isCurrentGeneratedDocument: true,
			},
		]);

		expect(ranked[0]).toMatchObject({
			artifactId: "out-focused",
			selected: true,
			reasonCodes: expect.arrayContaining(["active_document_focus"]),
		});
		expect(ranked[1]?.artifactId).toBe("out-latest");
	});

	it("boosts an actively corrected document above generic generated-output recency", () => {
		const ranked = rankWorkingSetCandidates([
			{
				artifactId: "out-corrected",
				artifactType: "generated_output",
				name: "Corrected brief",
				summary: null,
				contentText: null,
				updatedAt: Date.now(),
				isRecentUserCorrection: true,
			},
			{
				artifactId: "out-latest",
				artifactType: "generated_output",
				name: "Latest generated document",
				summary: null,
				contentText: null,
				updatedAt: Date.now(),
				isCurrentGeneratedDocument: true,
			},
		]);

		expect(ranked[0]).toMatchObject({
			artifactId: "out-corrected",
			selected: true,
			reasonCodes: expect.arrayContaining(["recent_user_correction"]),
		});
	});

	it("keeps the most recently refined document family above generic generated-output recency", () => {
		const ranked = rankWorkingSetCandidates([
			{
				artifactId: "out-refined-family",
				artifactType: "generated_output",
				name: "Refined brief",
				summary: null,
				contentText: null,
				updatedAt: Date.now(),
				isRecentlyRefinedDocumentFamily: true,
			},
			{
				artifactId: "out-latest",
				artifactType: "generated_output",
				name: "Latest generated document",
				summary: null,
				contentText: null,
				updatedAt: Date.now(),
				isCurrentGeneratedDocument: true,
			},
		]);

		expect(ranked[0]).toMatchObject({
			artifactId: "out-refined-family",
			selected: true,
			reasonCodes: expect.arrayContaining(["recently_refined_document_family"]),
		});
	});

	it("carries broad active document sets across turns", () => {
		const ranked = rankWorkingSetCandidates([
			...Array.from({ length: 12 }, (_, index) => ({
				artifactId: `doc-${index + 1}`,
				artifactType: "source_document" as const,
				name: `Document ${index + 1}`,
				summary: null,
				contentText: null,
				updatedAt: Date.now(),
				isAttachedThisTurn: true,
			})),
		]);

		const selected = ranked.filter((item) => item.selected);
		expect(selected).toHaveLength(12);
		expect(new Set(selected.map((item) => item.artifactId))).toEqual(
			new Set(Array.from({ length: 12 }, (_, index) => `doc-${index + 1}`)),
		);
	});

	it("keeps a generous performance safeguard on active working-set size", () => {
		const ranked = rankWorkingSetCandidates([
			...Array.from({ length: 60 }, (_, index) => ({
				artifactId: `doc-${index + 1}`,
				artifactType: "source_document" as const,
				name: `Document ${index + 1}`,
				summary: null,
				contentText: null,
				updatedAt: Date.now(),
				isAttachedThisTurn: true,
			})),
			...Array.from({ length: 20 }, (_, index) => ({
				artifactId: `out-${index + 1}`,
				artifactType: "generated_output" as const,
				name: `Output ${index + 1}`,
				summary: null,
				contentText: null,
				updatedAt: Date.now(),
				isCurrentGeneratedDocument: index === 0,
				isActiveDocumentFocus: index === 1,
				isRecentlyRefinedDocumentFamily: index > 1,
			})),
		]);

		const selected = ranked.filter((item) => item.selected);
		expect(selected).toHaveLength(64);
		expect(
			selected.filter((item) => item.artifactType === "source_document"),
		).toHaveLength(48);
		expect(
			selected.filter((item) => item.artifactType === "generated_output"),
		).toHaveLength(16);
	});

	it("boosts message-matched documents above non-matched ones", () => {
		const ranked = rankWorkingSetCandidates([
			{
				artifactId: "doc-matched",
				artifactType: "source_document",
				name: "Project roadmap",
				summary: null,
				contentText: null,
				updatedAt: Date.now(),
				messageMatchScore: 3,
			},
			{
				artifactId: "doc-unmatched",
				artifactType: "source_document",
				name: "Unrelated document",
				summary: null,
				contentText: null,
				updatedAt: Date.now(),
			},
		]);

		expect(ranked[0]?.artifactId).toBe("doc-matched");
		expect(ranked[0]?.reasonCodes).toContain("matched_current_turn");
	});

	it("stacks multiple strong signals for highest priority", () => {
		const ranked = rankWorkingSetCandidates([
			{
				artifactId: "doc-multi",
				artifactType: "source_document",
				name: "Important brief",
				summary: null,
				contentText: null,
				updatedAt: Date.now(),
				isAttachedThisTurn: true,
				isActiveDocumentFocus: true,
				messageMatchScore: 2,
			},
			{
				artifactId: "doc-single",
				artifactType: "source_document",
				name: "Single signal brief",
				summary: null,
				contentText: null,
				updatedAt: Date.now(),
				isAttachedThisTurn: true,
			},
		]);

		expect(ranked[0]?.artifactId).toBe("doc-multi");
		expect(ranked[1]?.artifactId).toBe("doc-single");
	});

	it("applies decay penalty to old artifacts", () => {
		const now = Date.now();
		const ranked = rankWorkingSetCandidates([
			{
				artifactId: "doc-old",
				artifactType: "source_document",
				name: "Old document",
				summary: null,
				contentText: null,
				updatedAt: now - 30 * 24 * 60 * 60 * 1000,
				isAttachedThisTurn: true,
			},
			{
				artifactId: "doc-new",
				artifactType: "source_document",
				name: "New document",
				summary: null,
				contentText: null,
				updatedAt: now,
				isAttachedThisTurn: true,
			},
		]);

		expect(ranked[0]?.artifactId).toBe("doc-new");
		expect(ranked[1]?.artifactId).toBe("doc-old");
		expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 0);
	});
});
