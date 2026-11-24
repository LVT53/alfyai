import { rerankTexts } from "../tei-reranker";
import { clipMentionText } from "./earlier-mention";

/**
 * The reranker half of the Earlier gate. An Earlier entry that ranks in its
 * bank's top three joins a turn only when the person's message is about it.
 * The word rule (`earlier-mention.ts`) misses a message that names the thing
 * in other words, and in another language, and it lets a shared ordinary word
 * through: on the blind set it brought in 52% of the entries a message was
 * about and 25% of the entries of an unrelated one. The app's own reranker
 * reads meaning, so the gate is both together, on its score (a sigmoid,
 * 0 to 1):
 *
 * - at least `min`: the message is about the entry;
 * - from `wordMin` to under `min`: only when the word rule agrees;
 * - under `wordMin`: never, whatever the words say.
 *
 * Measured on production's `bge-reranker-v2-m3` (every Earlier entry counted
 * as ranked in the top three): 77% of the messages about an entry bring it in,
 * 8% of the unrelated ones bring one, and a wrong extra entry rides along 16%
 * of the time (`docs/plans/hindsight-memory/label-migration-acceptance/
 * earlier-rerank/`). With no score the word rule decides alone.
 */
export interface EarlierRerankThresholds {
	/** A score at or above this lets an entry in. */
	min: number;
	/** A score at or above this lets an entry in when the words mention it. */
	wordMin: number;
}

/** An Earlier entry that ranks high enough to be judged: its key and the text the model would read. */
export interface EarlierCandidate {
	key: string;
	text: string;
}

/** A candidate with the word rule's verdict on it, so a score can be told to change that verdict or not. */
export interface JudgedCandidate extends EarlierCandidate {
	byWords: boolean;
}

/** The reranker's score for each candidate it scored, with the text it scored. */
export type EarlierScores = ReadonlyMap<
	string,
	{ text: string; score: number }
>;

/** One call per turn scores this many entries at most (TEI refuses more than 32). */
export const EARLIER_RERANK_MAX_TEXTS = 6;
/** The call is optional, so it never holds a turn longer than this. */
export const EARLIER_RERANK_TIMEOUT_MS = 500;

/**
 * Whether an Earlier entry joins the turn. `score` is the reranker's, or
 * undefined when it gave none, and then the word rule alone decides.
 * `mentionedByWords` is asked only when the words are needed.
 */
export function earlierJoins(
	score: number | undefined,
	mentionedByWords: () => boolean,
	{ min, wordMin }: EarlierRerankThresholds,
): boolean {
	if (score === undefined) return mentionedByWords();
	if (score >= min) return true;
	return score >= wordMin && mentionedByWords();
}

/**
 * The score of a candidate, or undefined when it has none or was scored on
 * other text: a score is a judgement of the text it was given.
 */
export function earlierScoreOf(
	scores: EarlierScores | undefined,
	candidate: EarlierCandidate,
): number | undefined {
	const scored = scores?.get(candidate.key);
	return scored && scored.text === candidate.text ? scored.score : undefined;
}

/** Whether the scores move any candidate from the word rule's verdict, so that judging again is worth it. */
export function scoresChangeADecision(
	candidates: readonly JudgedCandidate[],
	scores: EarlierScores,
	floors: EarlierRerankThresholds,
): boolean {
	return candidates.some(
		(candidate) =>
			earlierJoins(
				earlierScoreOf(scores, candidate),
				() => candidate.byWords,
				floors,
			) !== candidate.byWords,
	);
}

type Unavailable = "not_configured" | "timeout" | "error" | "empty" | "scores";

/** No reranker is the deployment's choice, not a fault: it is said once per process. */
let saidNotConfigured = false;

function unavailable(code: Unavailable): null {
	if (code === "not_configured") {
		if (saidNotConfigured) return null;
		saidNotConfigured = true;
	}
	console.warn("[KNOWLEDGE_MEMORY] Earlier rerank unavailable", { code });
	return null;
}

/** fetch ends a call its deadline aborted with an `AbortError` (`TimeoutError` for a timeout signal). */
function endedByItsDeadline(error: unknown): boolean {
	const name = (error as { name?: unknown } | null)?.name;
	return name === "AbortError" || name === "TimeoutError";
}

/** A half of an emoji the cut left alone; a JSON body with it is refused by the reranker. */
const LONE_SURROGATE =
	/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Scores a turn's Earlier candidates against the person's message in one
 * call. The message is the person's own words, never the chat's title, cut as
 * the word rule cuts it. Returns null, and logs one content-free line with the
 * reason, when there are no scores to use (no reranker, a timeout, an error,
 * an empty answer, scores outside 0 to 1): the word rule then decides alone,
 * and a turn never fails for it. Returns null without a line when there is
 * nothing to score. A score outside 0 to 1 is no score: a server that answers
 * raw logits would otherwise veto or admit every entry.
 */
export async function scoreEarlierCandidates(
	message: string,
	candidates: readonly EarlierCandidate[],
): Promise<EarlierScores | null> {
	const query = clipMentionText(message).replace(LONE_SURROGATE, "").trim();
	const asked = candidates.slice(0, EARLIER_RERANK_MAX_TEXTS);
	if (!query || !asked.length) return null;
	let results: Awaited<ReturnType<typeof rerankTexts>>;
	try {
		results = await rerankTexts({
			query,
			texts: asked.map(({ text }) => text),
			maxTexts: EARLIER_RERANK_MAX_TEXTS,
			timeoutMs: EARLIER_RERANK_TIMEOUT_MS,
		});
	} catch (error) {
		return unavailable(endedByItsDeadline(error) ? "timeout" : "error");
	}
	if (results === null) return unavailable("not_configured");
	if (!results.length) return unavailable("empty");
	const scores = new Map<string, { text: string; score: number }>();
	for (const { index, score } of results) {
		const candidate = asked[index];
		if (candidate && Number.isFinite(score) && score >= 0 && score <= 1)
			scores.set(candidate.key, { text: candidate.text, score });
	}
	return scores.size ? scores : unavailable("scores");
}
