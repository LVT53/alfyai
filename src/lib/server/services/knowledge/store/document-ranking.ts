/**
 * How a document search puts its three relevance signals on one line.
 *
 *   lexical   how many of the query's words (three letters or more) the document
 *             contains, as a share of the query's words;
 *   semantic  the embedder's cosine between the query and the document, for the
 *             documents in its shortlist and nobody else;
 *   rerank    the reranker's probability, for the documents it was shown.
 *
 * Plain arithmetic, so the weights can be read and tested without a database or a
 * model. The weights (10 / 18 / 24) are the ones this ranking has always written
 * down. What changed is that they count: the sum used to be multiplied by
 * `exp(-0.011 * ageInSeconds)`, which is nothing after ten minutes, so a document
 * written yesterday was ordered by `0.35 * lexicalScore` alone. A question in one
 * language never found the document that answers it in the other, and a paraphrase
 * lost to any document that shared a few everyday words with the question.
 *
 * Recency is not here. It stays a tie-break at the end of the caller's sum.
 *
 * Why these shapes, and the numbers they were chosen on (public Hungarian and
 * English text, 120 candidates a query, the real embedder and reranker):
 * docs/plans/document-ranking/README.md.
 */

const LEXICAL_WEIGHT = 10;
const SEMANTIC_WEIGHT = 18;
const RERANK_WEIGHT = 24;

/**
 * Added when a query of several words is found whole in a document: a phrase or a
 * name quoted from it. The embedder reads a fragment of a long document as a poor
 * match for the whole of it, so without this a quoted phrase loses to a document
 * that is merely about the same subject.
 */
const EVERY_WORD_BONUS = 8;
const EVERY_WORD_MIN_QUERY_TERMS = 3;

type DocumentSignals = {
	/** `scoreMatch`: how many of the query's words the document contains. */
	lexicalScore: number;
	/** `countMatchTerms`: how many words the query has, the most `lexicalScore` can be. */
	queryTermCount: number;
	/** The embedder's cosine, 0 for a document outside its shortlist. */
	semanticScore: number;
	/** The reranker's probability, 0 for a document it was not shown. */
	rerankScore: number;
};

/**
 * What the words are worth. A share of the query, squared: most of a query's words
 * are everyday ones ("the", "for", "notice") that any document might hold, so a
 * document must hold most of them before the words weigh against what it means.
 */
function lexicalPoints({
	lexicalScore,
	queryTermCount,
}: Pick<DocumentSignals, "lexicalScore" | "queryTermCount">): number {
	if (queryTermCount <= 0) return 0;
	const share = Math.min(lexicalScore / queryTermCount, 1);
	const holdsEveryWord =
		queryTermCount >= EVERY_WORD_MIN_QUERY_TERMS &&
		lexicalScore >= queryTermCount;
	return LEXICAL_WEIGHT * share ** 2 + (holdsEveryWord ? EVERY_WORD_BONUS : 0);
}

/**
 * Everything there is to go on before the reranker has seen a document, so also
 * what decides which documents it is shown: it scores only the first few it is
 * handed (`TEI_RERANKER_MAX_TEXTS`).
 */
export function scoreBeforeRerank(
	signals: Omit<DocumentSignals, "rerankScore">,
): number {
	return lexicalPoints(signals) + SEMANTIC_WEIGHT * signals.semanticScore;
}

export function scoreRelevance(signals: DocumentSignals): number {
	return scoreBeforeRerank(signals) + RERANK_WEIGHT * signals.rerankScore;
}
