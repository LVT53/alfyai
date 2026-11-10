import { describe, expect, it } from "vitest";
import {
	countMatchTerms,
	rankWorkingSetCandidates,
	scoreMatch,
	type WorkingSetCandidate,
} from "./working-set";

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
});

// How long ago a document was last written says nothing about whether the person
// is still working with it. The signals are the turn's own verdict (it is attached,
// it is open and named, it was corrected, its family was refined, it is the
// current generated document); the age of the file used to be multiplied into
// them, in SECONDS, as exp(-0.011 * age): 0.001 after ten minutes, so a document
// written more than about two minutes before the refresh fell under the cut of 20
// whatever the turn said about it.
describe("working-set ranking and how long ago a document was written", () => {
	const HOUR = 60 * 60 * 1000;
	const DAY = 24 * HOUR;

	function candidate(
		overrides: Partial<WorkingSetCandidate> & { ageMs?: number },
	): WorkingSetCandidate {
		const { ageMs = 0, ...rest } = overrides;
		return {
			artifactId: "doc",
			artifactType: "generated_output",
			name: "Lease review",
			summary: null,
			contentText: null,
			updatedAt: Date.now() - ageMs,
			...rest,
		};
	}

	it.each([
		["attached this turn", { isAttachedThisTurn: true }, 100],
		["the active document focus", { isActiveDocumentFocus: true }, 92],
		["a recent user correction", { isRecentUserCorrection: true }, 62],
		[
			"a recently refined document family",
			{ isRecentlyRefinedDocumentFamily: true },
			58,
		],
		[
			"the current generated document",
			{ isCurrentGeneratedDocument: true },
			54,
		],
	] as const)("keeps a document on the signal %s, however long ago it was written", (_name, signal, weight) => {
		for (const ageMs of [0, HOUR, DAY, 30 * DAY]) {
			const [item] = rankWorkingSetCandidates([
				candidate({ ...signal, ageMs }),
			]);

			expect(item).toMatchObject({
				selected: true,
				state: "active",
				score: weight,
			});
		}
	});

	it("does not keep a document nothing points to, however recently it was written", () => {
		const [item] = rankWorkingSetCandidates([candidate({ ageMs: 0 })]);

		expect(item).toMatchObject({ selected: false, state: "cooling", score: 0 });
	});

	it("lets a match with the message alone keep a document written moments ago, not one written an hour ago", () => {
		// The one place the age still counts. A match is three-letter pieces of the
		// message found anywhere in the text ("the", "and" ...), so nearly every
		// reply of a chat matches the next question. With nothing to age them, the
		// replies of a long chat all stay in the working set and the prompt.
		const [fresh] = rankWorkingSetCandidates([
			candidate({ messageMatchScore: 3 }),
		]);
		const [old] = rankWorkingSetCandidates([
			candidate({ messageMatchScore: 3, ageMs: HOUR }),
		]);

		expect(fresh).toMatchObject({ selected: true, state: "active" });
		expect(old).toMatchObject({ selected: false, state: "cooling" });
		expect(old.reasonCodes).toEqual(["matched_current_turn"]);
	});

	it("puts the document written last first when the signals are equal", () => {
		// The ids sort the other way round, so only the age can put "z-newer" first.
		const ranked = rankWorkingSetCandidates([
			candidate({
				artifactId: "a-older",
				ageMs: 3 * DAY,
				isActiveDocumentFocus: true,
			}),
			candidate({
				artifactId: "z-newer",
				ageMs: HOUR,
				isActiveDocumentFocus: true,
			}),
		]);

		expect(ranked.map((item) => item.artifactId)).toEqual([
			"z-newer",
			"a-older",
		]);
		expect(ranked[0]?.score).toBe(ranked[1]?.score);
	});

	it("keeps the documents written last when more tie than the working set can hold", () => {
		// 60 documents tie on the signal and 48 fit. Their ids sort oldest first, so
		// the 48 that stay can only be the newest if the age breaks the tie.
		const ranked = rankWorkingSetCandidates(
			Array.from({ length: 60 }, (_, index) =>
				candidate({
					artifactId: `doc-${String(index).padStart(2, "0")}`,
					artifactType: "source_document",
					ageMs: (60 - index) * HOUR,
					isAttachedThisTurn: true,
				}),
			),
		);

		const selected = ranked
			.filter((item) => item.selected)
			.map((item) => item.artifactId)
			.sort();
		expect(selected).toEqual(
			Array.from(
				{ length: 48 },
				(_, index) => `doc-${String(index + 12).padStart(2, "0")}`,
			),
		);
	});
});

describe("scoreMatch term splitting", () => {
	it("splits a multi-word query into terms and counts each hit", () => {
		expect(
			scoreMatch("lease renewal clause", "The lease has a renewal clause."),
		).toBe(3);
		expect(scoreMatch("lease renewal clause", "a document about parking")).toBe(
			0,
		);
		expect(scoreMatch("lease\trenewal\n clause", "renewal only")).toBe(1);
	});

	it("drops terms of two characters or fewer", () => {
		expect(scoreMatch("is it in the pdf", "the pdf")).toBe(2);
	});
});

describe("countMatchTerms", () => {
	it("counts the terms scoreMatch looks for, a repeated word as often as it is written", () => {
		expect(
			countMatchTerms("notice period for ending the rental contract"),
		).toBe(7);
		expect(countMatchTerms("is it in the pdf")).toBe(2);
		expect(countMatchTerms("launch launch plan")).toBe(3);
		expect(countMatchTerms("  \t ")).toBe(0);
	});

	it("is the most scoreMatch can return for that query", () => {
		const query = "lease renewal\tclause for the lease";
		expect(scoreMatch(query, query)).toBe(countMatchTerms(query));
	});
});
