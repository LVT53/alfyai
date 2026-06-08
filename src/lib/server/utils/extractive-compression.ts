const STOPWORDS = new Set([
	'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of',
	'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
	'have', 'has', 'had', 'do', 'does', 'did',
	'will', 'would', 'should', 'could', 'can', 'may', 'might', 'must'
]);

export interface ExtractiveCompressionResult {
	/** The compressed text with selected sentences in original order */
	text: string;
	/** Compression ratio: (original - compressed) / original */
	compressionRatio: number;
}

export interface ExtractiveCompressionParams {
	/** Text chunks to compress */
	chunks: string[];
	/** Query for relevance scoring */
	query: string;
	/** Maximum characters to include */
	maxChars: number;
}

interface SentenceWithMeta {
	text: string;
	score: number;
	originalPosition: number;
}

function splitIntoSentences(text: string): string[] {
	const parts = text.split(/(?<=[.?!])(\n? )?/);
	const sentences: string[] = [];
	for (const part of parts) {
		if (part) {
			const trimmed = part.trim();
			if (trimmed) sentences.push(trimmed);
		}
	}
	return sentences;
}

/**
 * Tokenize text with stopword filtering.
 * Split on non-alphanumeric, convert to lowercase, filter stopwords.
 */
function tokenizeStopwordFree(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(token => token.length > 0 && !STOPWORDS.has(token));
}

export function sentenceTokenOverlap(query: string, sentence: string): number {
	const queryTokens = tokenizeStopwordFree(query);
	if (queryTokens.length === 0) return 0;

	const sentenceTokens = new Set(tokenizeStopwordFree(sentence));
	return queryTokens.filter(token => sentenceTokens.has(token)).length;
}

/**
 * Score a sentence by token overlap with query.
 * score = |queryTokens ∩ sentenceTokens| / |queryTokens|
 * Returns 0 if query tokens is empty.
 */
function scoreSentence(query: string, sentence: string): number {
	const queryTokens = tokenizeStopwordFree(query);
	if (queryTokens.length === 0) return 0;

	const overlap = sentenceTokenOverlap(query, sentence);
	return overlap / queryTokens.length;
}

export function extractiveCompress(params: ExtractiveCompressionParams): ExtractiveCompressionResult {
	const { chunks, query, maxChars } = params;

	if (chunks.length === 0) {
		return { text: '', compressionRatio: 0 };
	}

	if (maxChars <= 0) {
		return { text: '', compressionRatio: 1 };
	}

	// Calculate original total chars
	const originalTotalChars = chunks.reduce((sum, chunk) => sum + chunk.length, 0);

	// Extract all sentences with their positions
	const allSentences: SentenceWithMeta[] = [];
	let globalPosition = 0;

	for (const chunk of chunks) {
		const sentences = splitIntoSentences(chunk);
		for (const sentence of sentences) {
			const score = query.trim() ? scoreSentence(query, sentence) : 0;
			allSentences.push({
				text: sentence,
				score,
				originalPosition: globalPosition++
			});
		}
	}

	// Fallback: when query is empty, return first N sentences within budget
	if (!query.trim()) {
		const selected: string[] = [];
		let charCount = 0;

		for (const sentence of allSentences) {
			if (charCount + sentence.text.length > maxChars) {
				break;
			}
			selected.push(sentence.text);
			charCount += sentence.text.length;
		}

		const compressedText = selected.join(' ');
		const compressedChars = compressedText.length;
		const compressionRatio = originalTotalChars > 0
			? (originalTotalChars - compressedChars) / originalTotalChars
			: 0;

		return { text: compressedText, compressionRatio };
	}

	// Sort by score descending (for greedy selection)
	const sortedByScore = [...allSentences].sort((a, b) => b.score - a.score);

	// Greedy selection: pick highest-scoring sentences within budget
	const selected: SentenceWithMeta[] = [];
	let charCount = 0;

	for (const sentence of sortedByScore) {
		if (charCount + sentence.text.length > maxChars) {
			continue;
		}
		selected.push(sentence);
		charCount += sentence.text.length;
	}

	// Sort selected sentences back into ORIGINAL document order
	selected.sort((a, b) => a.originalPosition - b.originalPosition);

	const compressedText = selected.map(s => s.text).join(' ');
	const compressedChars = compressedText.length;
	const compressionRatio = originalTotalChars > 0
		? (originalTotalChars - compressedChars) / originalTotalChars
		: 0;

	return { text: compressedText, compressionRatio };
}