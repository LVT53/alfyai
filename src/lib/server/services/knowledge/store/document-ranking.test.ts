// The shape of the relevance sum, stated as relations rather than as the numbers
// they came from: how the weights were chosen is in docs/plans/document-ranking/.
// documents.ranking-order.test.ts shows what the shape does to a search.

import { describe, expect, it } from "vitest";
import { scoreBeforeRerank, scoreRelevance } from "./document-ranking";

describe("document relevance", () => {
	it("counts half of a query's words for less than half of the credit for all of them", () => {
		const base = { queryTermCount: 2, semanticScore: 0, rerankScore: 0 };
		const half = scoreRelevance({ ...base, lexicalScore: 1 });
		const all = scoreRelevance({ ...base, lexicalScore: 2 });

		expect(half).toBeGreaterThan(0);
		expect(half).toBeLessThan(all / 2);
	});

	it("adds a bonus when a query of three words or more is found whole, and none for a shorter query", () => {
		const base = { semanticScore: 0 };
		const wholeOfThree = scoreBeforeRerank({
			...base,
			queryTermCount: 3,
			lexicalScore: 3,
		});
		const twoOfThree = scoreBeforeRerank({
			...base,
			queryTermCount: 3,
			lexicalScore: 2,
		});
		const wholeOfTwo = scoreBeforeRerank({
			...base,
			queryTermCount: 2,
			lexicalScore: 2,
		});
		const oneOfTwo = scoreBeforeRerank({
			...base,
			queryTermCount: 2,
			lexicalScore: 1,
		});

		// The third word of three adds a smaller share than the second word of two,
		// and is still worth more: the bonus.
		expect(wholeOfThree - twoOfThree).toBeGreaterThan(wholeOfTwo - oneOfTwo);
		expect(wholeOfTwo).toBeLessThan(wholeOfThree);
	});

	it("scores a query with no searchable word by what the document means, not by a division by zero", () => {
		const meaning = { semanticScore: 0.5, rerankScore: 0.5, queryTermCount: 0 };

		expect(scoreRelevance({ ...meaning, lexicalScore: 0 })).toBeGreaterThan(0);
		expect(scoreRelevance({ ...meaning, lexicalScore: 0 })).toBe(
			scoreRelevance({ ...meaning, lexicalScore: 3 }),
		);
	});

	it("adds the reranker's verdict to what was known before it, and nothing else", () => {
		const known = { lexicalScore: 2, queryTermCount: 4, semanticScore: 0.6 };

		expect(scoreRelevance({ ...known, rerankScore: 0 })).toBe(
			scoreBeforeRerank(known),
		);
		expect(scoreRelevance({ ...known, rerankScore: 0.9 })).toBeGreaterThan(
			scoreBeforeRerank(known),
		);
	});
});
