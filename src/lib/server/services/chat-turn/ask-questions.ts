import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import { askQuestions } from "$lib/server/db/schema";
import {
	type AskAnswer,
	type AskQuestion,
	type AskQuestionDto,
	type AskQuestionStatus,
	parseAskAnswer,
	parseAskQuestions,
} from "$lib/shared/ask-user";
import { parseNormalChatContinuation } from "../normal-chat-model";
import { getOrphanedStream } from "./active-streams";
import {
	type HistoryToolDigest,
	isHistoryToolDigest,
} from "./conversation-history";

// The questions Alfy stops a reply to ask ("Ask me first", docs/plans/ask-me-first,
// design 5.4 and 5.5): the question, the person's answer, and what the resume
// needs to carry the same reply on. The table is `ask_questions`.
//
// A question's status moves like this:
//   waiting   -> answering            an answer claimed it (claimAskQuestion)
//   answering -> waiting              the resume did not land; the answer stays
//                                     on the row (releaseAskQuestion)
//   answering -> answered | closed    the resume's segment was saved
//                                     (settleAskQuestion; closed is the X)
//   answering -> discarded            the resume can never be prepared: the reply
//                                     has lost the shape a resume starts from
//                                     (discardClaimedAskQuestion)
//   waiting   -> discarded            the reply never saved it (the discard calls)
// A question has no asking row (`assistant_message_id`) until the asking
// segment is saved; stampAskQuestion then writes the row and the capture in one
// UPDATE, and only a stamped question can be claimed.
//
// Every statement below is synchronous (better-sqlite3), so no function yields
// to another in the middle of its work. The functions are `async` only so that
// callers `await` them as they would any store.

export type AskQuestionRow = typeof askQuestions.$inferSelect;

/** One tool result of the paused segment, kept so a resume can gate it for each model attempt. */
export type AskCapturedResult = {
	toolCallId: string;
	toolName: string;
	/** A local model already summarised the result held in `messages`. */
	localDistilled: boolean;
	digest: HistoryToolDigest;
};

/**
 * What a resume needs: what follows the person's message in the model input
 * (the reply so far, tool results in full), and one row for each tool result.
 */
export type AskResumeCapture = {
	v: 1 | 2;
	continuation?: string;
	messages: ModelMessage[];
	results: AskCapturedResult[];
};

/**
 * A won claim carries its `claim`: the token that release and settle must
 * present. Only the holder of the live claim can release or settle the question.
 */
export type AskClaimResult =
	| { ok: true; row: AskQuestionRow; claim: string }
	| { ok: false; reason: "not_found" | "not_waiting" };

// The questions whose resume is running in this process, each with the token of
// the claim that started it. A row that says `answering` cannot tell whether a
// resume stands behind it: a restart or a crash leaves such rows with nothing
// behind them. This map tells.
//
// A won claim sets its token in the same synchronous step as its UPDATE and
// hands it to its caller. Release and settle act only for the token they hold,
// and then clear the entry whether or not their UPDATE changed a row. Any other
// call (a second release for one claim, a settle from a superseded attempt)
// changes neither the row nor the map, so it can never undo another device's
// later claim. A restart empties the map. A claim releases an `answering` row
// only when the map has no entry for it, so a second device's answer can never
// undo a first one whose stream has not registered yet: the route prepares the
// turn between the claim and the stream, and the chat's stream registry
// (`getOrphanedStream`) says nothing in that window.
//
// Every path after a won claim must end in one release, one settle or one discard
// with its token (the route's errors and throws, the orchestrator's `finally`, the
// preparation that finds the reply can never be resumed), or the chat would
// refuse new messages, with no card to answer, until a restart.
const liveResumes = new Map<string, string>();

/** Whether `claim` is the claim the live resume of this question was started under. */
function holdsLiveClaim(questionId: string, claim: string): boolean {
	const live = liveResumes.get(questionId);
	return live !== undefined && live === claim;
}

// --- writing ----------------------------------------------------------------

/** Records a question the model just asked: waiting, with no asking row yet. */
export async function recordAskQuestion(p: {
	userId: string;
	conversationId: string;
	toolCallId: string;
	questions: AskQuestion[];
}): Promise<{ id: string }> {
	const id = randomUUID();
	db.insert(askQuestions)
		.values({
			id,
			userId: p.userId,
			conversationId: p.conversationId,
			toolCallId: p.toolCallId,
			questionsJson: JSON.stringify(p.questions),
		})
		.run();
	return { id };
}

/**
 * Ties a question to the row that asked it, in the same UPDATE that keeps the
 * capture for the resume. Only an unstamped waiting question is stamped, so a
 * second stamp, or a stamp that comes after a discard, changes nothing and
 * answers false.
 */
export async function stampAskQuestion(p: {
	userId: string;
	questionId: string;
	assistantMessageId: string;
	capture: AskResumeCapture;
}): Promise<boolean> {
	const stamped = db
		.update(askQuestions)
		.set({
			assistantMessageId: p.assistantMessageId,
			resumeJson: JSON.stringify(p.capture),
		})
		.where(
			and(
				eq(askQuestions.id, p.questionId),
				eq(askQuestions.userId, p.userId),
				eq(askQuestions.status, "waiting"),
				isNull(askQuestions.assistantMessageId),
			),
		)
		.run();
	return stamped.changes === 1;
}

/** Discards a question the reply never saved (a turn that ended without saving, or was stopped). */
export async function discardAskQuestion(p: {
	userId: string;
	questionId: string;
}): Promise<void> {
	db.update(askQuestions)
		.set({ status: "discarded", settledAt: new Date(), resumeJson: null })
		.where(
			and(
				eq(askQuestions.id, p.questionId),
				eq(askQuestions.userId, p.userId),
				eq(askQuestions.status, "waiting"),
				isNull(askQuestions.assistantMessageId),
			),
		)
		.run();
}

/**
 * The sweep at a turn's start: discards the chat's questions that were never
 * saved with a reply (a crash left them). Answers how many it discarded.
 */
export async function discardStaleAskQuestions(p: {
	userId: string;
	conversationId: string;
}): Promise<number> {
	const discarded = db
		.update(askQuestions)
		.set({ status: "discarded", settledAt: new Date(), resumeJson: null })
		.where(
			and(
				eq(askQuestions.userId, p.userId),
				eq(askQuestions.conversationId, p.conversationId),
				eq(askQuestions.status, "waiting"),
				isNull(askQuestions.assistantMessageId),
			),
		)
		.run();
	return discarded.changes;
}

// --- the answer -------------------------------------------------------------

/** One question of a person's chat, in whatever state it is; null when there is none. */
export async function getAskQuestion(p: {
	userId: string;
	conversationId: string;
	questionId: string;
}): Promise<AskQuestionRow | null> {
	const row = db
		.select()
		.from(askQuestions)
		.where(
			and(
				eq(askQuestions.id, p.questionId),
				eq(askQuestions.userId, p.userId),
				eq(askQuestions.conversationId, p.conversationId),
			),
		)
		.get();
	return row ?? null;
}

/**
 * Whether an answer to this question has nothing left to win, as far as that can be
 * told without making the claim: the question is answered or closed, or it is
 * answering and a resume of this process runs it (`liveResumes`, the only thing that
 * can tell an answer on its way from a restart's leftover row). It only reads: the
 * claim stays the one arbiter, and this answers early what the claim would answer
 * anyway (`not_waiting`), so that the answer route can tell a tab that lost the race
 * so at once, before the stream gate: the winner's resume holds the one stream a
 * person may run, and a loser that met the gate first would be told to wait for room
 * to lose a claim it could never win. An `answering` row with no resume behind it is
 * not taken (a restart left it: the claim releases it and may win it), and neither is
 * a question that waits, is not saved yet, was discarded or is not there: the gate and
 * the claim meet those as they always did.
 */
export async function isAskQuestionTaken(p: {
	userId: string;
	conversationId: string;
	questionId: string;
}): Promise<boolean> {
	const row = db
		.select({ id: askQuestions.id, status: askQuestions.status })
		.from(askQuestions)
		.where(
			and(
				eq(askQuestions.id, p.questionId),
				eq(askQuestions.userId, p.userId),
				eq(askQuestions.conversationId, p.conversationId),
			),
		)
		.get();
	if (!row) return false;
	if (row.status === "answered" || row.status === "closed") return true;
	return row.status === "answering" && liveResumes.has(row.id);
}

/**
 * Claims a waiting question for an answer, so that one answer wins across
 * devices and double taps. The caller passes the answer that `checkAskAnswer`
 * returned: one that `parseAskAnswer` rejects is a caller's bug and throws. A
 * won claim writes the answer (as it reads back), leaves the question
 * `answering` and hands back the `claim` token that its one release or settle
 * must present. A claim that loses answers `not_waiting`, and so does a row the
 * list cannot read (`readRow`), which shows no card to answer; `not_found` means
 * this person has no such question in this chat.
 */
export async function claimAskQuestion(p: {
	userId: string;
	conversationId: string;
	questionId: string;
	answer: AskAnswer;
}): Promise<AskClaimResult> {
	const answer = parseAskAnswer(p.answer);
	if (answer === null) {
		throw new Error(
			"claimAskQuestion was given an answer that does not parse.",
		);
	}
	const question = and(
		eq(askQuestions.id, p.questionId),
		eq(askQuestions.userId, p.userId),
		eq(askQuestions.conversationId, p.conversationId),
	);

	// No `await` anywhere below, and none may be added. The read, the check of
	// the live-resume map, the release of a stale row, the claim UPDATE and the
	// map set run as one step for every caller in this process, because nothing
	// else can run between two synchronous statements. An `await` between one
	// claim's UPDATE and its map set would let a second claim see the row
	// `answering` with no resume live for it and release it; both devices would
	// then win and each start a resume.
	const current = db.select().from(askQuestions).where(question).get();
	if (!current) return { ok: false, reason: "not_found" };
	// a row the list cannot read shows no card, so nothing can answer it
	if (readRow(current) === null) return { ok: false, reason: "not_waiting" };
	if (!liveResumes.has(p.questionId)) {
		// `answering` with no resume behind it: a restart or a crash left it
		db.update(askQuestions)
			.set({ status: "waiting" })
			.where(and(question, eq(askQuestions.status, "answering")))
			.run();
	}
	const won: AskQuestionRow | undefined = db
		.update(askQuestions)
		.set({
			status: "answering",
			answerJson: JSON.stringify(answer),
			answeredAt: new Date(),
		})
		.where(
			and(
				question,
				eq(askQuestions.status, "waiting"),
				isNotNull(askQuestions.assistantMessageId),
			),
		)
		.returning()
		.get();
	if (!won) return { ok: false, reason: "not_waiting" };
	const claim = randomUUID();
	liveResumes.set(p.questionId, claim);
	return { ok: true, row: won, claim };
}

/**
 * The resume did not land: puts the question back to waiting, the answer kept,
 * so the card comes back with it. It acts only for the holder of the live claim,
 * with the `claim` its won claim handed back; any other call (a second release
 * for the same claim, one from a superseded attempt) changes neither the row nor
 * the map and answers false. The holder always clears its claim, whether or not
 * its UPDATE changed a row. True when a row changed.
 */
export async function releaseAskQuestion(p: {
	userId: string;
	questionId: string;
	claim: string;
}): Promise<boolean> {
	// No `await` from here to the return, and none may be added: the check of the
	// token, the clearing of the claim and the UPDATE are one step, like the
	// claim's. An `await` between the clearing and the UPDATE would let a second
	// claim win in the gap, and this UPDATE would then put that new winner's row
	// back to `waiting`.
	if (!holdsLiveClaim(p.questionId, p.claim)) return false;
	liveResumes.delete(p.questionId);
	const released = db
		.update(askQuestions)
		.set({ status: "waiting" })
		.where(
			and(
				eq(askQuestions.id, p.questionId),
				eq(askQuestions.userId, p.userId),
				eq(askQuestions.status, "answering"),
			),
		)
		.run();
	return released.changes > 0;
}

/**
 * The resume can never be prepared, so the question is closed for good: its reply
 * no longer has the shape a resume starts from (the capture is unreadable or
 * holds no result of the ask, the segments no longer lead back to the person's
 * message), and every try would fail the same way. Giving the claim back would
 * leave a card nobody can answer or close, in a chat that refuses new messages
 * while it waits. The question is `discarded` and its capture dropped, the answer
 * left on the row. Like release and settle it acts only for the holder of the
 * live claim and then always clears the claim; any other call changes neither the
 * row nor the map and answers false. True when a row changed.
 */
export async function discardClaimedAskQuestion(p: {
	userId: string;
	questionId: string;
	claim: string;
}): Promise<boolean> {
	// No `await` from here to the return, and none may be added; see release.
	if (!holdsLiveClaim(p.questionId, p.claim)) return false;
	liveResumes.delete(p.questionId);
	const discarded = db
		.update(askQuestions)
		.set({ status: "discarded", settledAt: new Date(), resumeJson: null })
		.where(
			and(
				eq(askQuestions.id, p.questionId),
				eq(askQuestions.userId, p.userId),
				eq(askQuestions.status, "answering"),
			),
		)
		.run();
	return discarded.changes > 0;
}

/**
 * The resume's segment was saved: the question is `answered`, or `closed` when
 * the answer was the X, and the capture is dropped. Like release, it acts only
 * for the holder of the live claim and then always clears the claim; any other
 * call (a settle from a superseded attempt) changes neither the row nor the map
 * and answers null. Answers the settled row (which still holds the answer), or
 * null when no question was answering.
 */
export async function settleAskQuestion(p: {
	userId: string;
	questionId: string;
	claim: string;
}): Promise<AskQuestionRow | null> {
	// No `await` from here to the return, and none may be added; see release.
	if (!holdsLiveClaim(p.questionId, p.claim)) return null;
	liveResumes.delete(p.questionId);
	const answering = and(
		eq(askQuestions.id, p.questionId),
		eq(askQuestions.userId, p.userId),
		eq(askQuestions.status, "answering"),
	);
	const row = db.select().from(askQuestions).where(answering).get();
	if (!row) return null;
	const settled: AskQuestionRow | undefined = db
		.update(askQuestions)
		.set({
			status:
				readAnswer(row.answerJson)?.kind === "closed" ? "closed" : "answered",
			resumeJson: null,
			settledAt: new Date(),
		})
		.where(answering)
		.returning()
		.get();
	return settled ?? null;
}

// --- the capture ------------------------------------------------------------

const MESSAGE_ROLES = new Set(["system", "user", "assistant", "tool"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModelMessage(value: unknown): value is ModelMessage {
	return (
		isRecord(value) &&
		typeof value.role === "string" &&
		MESSAGE_ROLES.has(value.role) &&
		(typeof value.content === "string" || Array.isArray(value.content))
	);
}

function isCapturedResult(value: unknown): value is AskCapturedResult {
	return (
		isRecord(value) &&
		typeof value.toolCallId === "string" &&
		typeof value.toolName === "string" &&
		typeof value.localDistilled === "boolean" &&
		isHistoryToolDigest(value.digest)
	);
}

function isCapture(value: unknown): value is AskResumeCapture {
	return (
		isRecord(value) &&
		(value.v === 1 ||
			(value.v === 2 && typeof value.continuation === "string")) &&
		Array.isArray(value.messages) &&
		value.messages.every(isModelMessage) &&
		Array.isArray(value.results) &&
		value.results.every(isCapturedResult)
	);
}

/** JSON.parse that answers undefined, which no reader accepts, for text that is not JSON. */
function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** What a stamped question kept for its resume; null when nothing is kept or it is not whole. */
export function readAskCapture(row: AskQuestionRow): AskResumeCapture | null {
	if (row.resumeJson === null) return null;
	const value = parseJson(row.resumeJson);
	if (!isCapture(value)) return null;
	if (value.v === 2) {
		try {
			parseNormalChatContinuation(value.continuation ?? "");
		} catch {
			return null;
		}
	}
	return value;
}

// --- reading ----------------------------------------------------------------

function readAnswer(json: string | null): AskAnswer | null {
	return json === null ? null : parseAskAnswer(parseJson(json));
}

/**
 * What a row says: its questions, and its answer when it has one. Null when
 * either cannot be read. This is the one test of "readable": the lists skip a
 * row that fails it, and the sidebar mark and the refusal count only rows that
 * pass it, so a chat is never refused a message while it shows no card.
 */
function readRow(
	row: Pick<AskQuestionRow, "questionsJson" | "answerJson">,
): { questions: AskQuestion[]; answer: AskAnswer | null } | null {
	const questions = parseAskQuestions(parseJson(row.questionsJson));
	const answer = readAnswer(row.answerJson);
	if (questions === null || (row.answerJson !== null && answer === null)) {
		return null;
	}
	return { questions, answer };
}

/**
 * The columns of a row that a card is made of: what `toDto`, `shownStatus` and
 * `readRow` read, and nothing else. The list selects exactly these, because a
 * stamped row's capture (`resumeJson`) can run to about a megabyte and the list
 * is read after every turn, hydrate, poll and write confirm.
 */
type AskQuestionListRow = Pick<
	AskQuestionRow,
	| "id"
	| "conversationId"
	| "assistantMessageId"
	| "toolCallId"
	| "questionsJson"
	| "status"
	| "answerJson"
	| "createdAt"
>;

/** How a row's status reads to the browser; null for a row it is not shown. */
function shownStatus(
	row: AskQuestionListRow,
	streamRuns: boolean,
): AskQuestionStatus | null {
	switch (row.status) {
		case "waiting":
			// Unsaved, the question belongs to a reply still being written: it shows
			// while that stream runs and is gone with the stream.
			return row.assistantMessageId === null && !streamRuns ? null : "waiting";
		case "answering":
			// With no resume live for it (a restart, a crash) it reads as waiting,
			// carrying the answer that did not go through.
			return liveResumes.has(row.id) ? "answering" : "waiting";
		case "answered":
		case "closed":
			return row.status;
		default:
			return null; // discarded
	}
}

function toDto(
	row: AskQuestionListRow,
	streamRuns: boolean,
): AskQuestionDto | null {
	const status = shownStatus(row, streamRuns);
	if (status === null) return null;
	const read = readRow(row);
	if (read === null) {
		// One row nobody can read must not fail the person's whole list. It is
		// named by its id: the questions and the answer are the person's words.
		console.warn("[ASK_QUESTIONS] Skipped a question that cannot be read", {
			id: row.id,
		});
		return null;
	}
	return {
		id: row.id,
		conversationId: row.conversationId,
		assistantMessageId: row.assistantMessageId,
		toolCallId: row.toolCallId,
		questions: read.questions,
		status,
		answer: read.answer,
		createdAt: row.createdAt.getTime(),
	};
}

/**
 * A chat's questions for the browser, in the order they were asked. Never a
 * discarded one, and never a question the reply has not saved once its stream
 * is gone; an `answering` question with no resume live reads as `waiting`,
 * with the answer that did not go through. Never the capture.
 */
export async function listConversationAskQuestions(p: {
	userId: string;
	conversationId: string;
}): Promise<AskQuestionDto[]> {
	const rows: AskQuestionListRow[] = db
		.select({
			id: askQuestions.id,
			conversationId: askQuestions.conversationId,
			assistantMessageId: askQuestions.assistantMessageId,
			toolCallId: askQuestions.toolCallId,
			questionsJson: askQuestions.questionsJson,
			status: askQuestions.status,
			answerJson: askQuestions.answerJson,
			createdAt: askQuestions.createdAt,
		})
		.from(askQuestions)
		.where(
			and(
				eq(askQuestions.userId, p.userId),
				eq(askQuestions.conversationId, p.conversationId),
			),
		)
		// A reply can ask twice in one second: the insert order settles it
		.orderBy(asc(askQuestions.createdAt), sql`rowid`)
		.all();
	const streamRuns =
		getOrphanedStream({
			userId: p.userId,
			conversationId: p.conversationId,
		}) !== null;
	return rows.flatMap((row) => {
		const dto = toDto(row, streamRuns);
		return dto ? [dto] : [];
	});
}

/**
 * Which of these chats the sidebar marks as waiting for an answer: those with a
 * saved question that waits, or that is `answering` with no resume live for it
 * (its card is back), and that the list can read, so a mark always has a card
 * behind it. It reads the person's open questions, which are few, and keeps
 * those in the chats asked about, so a long list of chat ids never reaches the
 * query. It is asked on every sidebar load, so it does not log a row it skips:
 * the list does.
 */
export async function listWaitingAskConversationIds(p: {
	userId: string;
	conversationIds: readonly string[];
}): Promise<Set<string>> {
	const marked = new Set<string>();
	if (p.conversationIds.length === 0) return marked;
	const asked = new Set(p.conversationIds);
	const open = db
		.select({
			id: askQuestions.id,
			conversationId: askQuestions.conversationId,
			status: askQuestions.status,
			questionsJson: askQuestions.questionsJson,
			answerJson: askQuestions.answerJson,
		})
		.from(askQuestions)
		.where(
			and(
				eq(askQuestions.userId, p.userId),
				isNotNull(askQuestions.assistantMessageId),
				inArray(askQuestions.status, ["waiting", "answering"]),
			),
		)
		.all();
	for (const row of open) {
		if (!asked.has(row.conversationId)) continue;
		if (row.status === "answering" && liveResumes.has(row.id)) continue;
		if (readRow(row) === null) continue;
		marked.add(row.conversationId);
	}
	return marked;
}

/**
 * Whether the chat holds a saved question that waits or answers, and that the
 * list can read: the reason a new message is refused. An answering question
 * counts whether or not its resume is live: the reply is on its way, or its
 * card is back. A question the list skips does not count, so a chat is never
 * refused a message while it shows no card to answer. It is asked on every
 * send, so it does not log a row it skips: the list does.
 */
export async function hasWaitingAskQuestion(p: {
	userId: string;
	conversationId: string;
}): Promise<boolean> {
	const open = db
		.select({
			questionsJson: askQuestions.questionsJson,
			answerJson: askQuestions.answerJson,
		})
		.from(askQuestions)
		.where(
			and(
				eq(askQuestions.userId, p.userId),
				eq(askQuestions.conversationId, p.conversationId),
				isNotNull(askQuestions.assistantMessageId),
				inArray(askQuestions.status, ["waiting", "answering"]),
			),
		)
		.all();
	return open.some((row) => readRow(row) !== null);
}
