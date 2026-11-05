import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import type { AskAnswer, AskQuestion } from "$lib/shared/ask-user";
import {
	type AskCapturedResult,
	type AskClaimResult,
	type AskQuestionRow,
	type AskResumeCapture,
	claimAskQuestion,
	discardAskQuestion,
	discardStaleAskQuestions,
	getAskQuestion,
	hasWaitingAskQuestion,
	isAskQuestionTaken,
	listConversationAskQuestions,
	listWaitingAskConversationIds,
	readAskCapture,
	recordAskQuestion,
	releaseAskQuestion,
	settleAskQuestion,
	stampAskQuestion,
} from "./ask-questions";

// The store reads and writes real rows through `$lib/server/db`, so these tests
// run it over a throwaway SQLite file migrated from ./drizzle, the harness of
// connections/pending-writes.test.ts.
let dbPath: string;
let sqlite: Database.Database;

vi.mock("$lib/server/db", () => ({
	get db() {
		return drizzle(sqlite, { schema });
	},
}));

// The registry of running streams, one stream id per person and chat. The
// store only asks it whether a chat's stream runs.
const streams = vi.hoisted(() => ({ running: new Map<string, string>() }));

vi.mock("./active-streams", () => ({
	getOrphanedStream: (p: { userId: string; conversationId: string }) =>
		streams.running.get(`${p.userId}:${p.conversationId}`) ?? null,
}));

const USER = "user-1";
const OTHER_USER = "user-2";
const CHAT = "chat-1";

// What the asking segment leaves for the resume: the reply so far, and one
// digest for the tool result in it.
const RESULT: AskCapturedResult = {
	toolCallId: "call-search",
	toolName: "research_web",
	localDistilled: false,
	digest: {
		ok: true,
		summary: "Found two sources.",
		detail: "Source A says so.",
		sources: [{ title: "A", url: "https://example.com/a" }, { title: "B" }],
	},
};

const CAPTURE: AskResumeCapture = {
	v: 1,
	messages: [
		{
			role: "assistant",
			content: [
				{
					type: "tool-call",
					toolCallId: "call-search",
					toolName: "research_web",
					input: { query: "colours" },
				},
			],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "call-search",
					toolName: "research_web",
					output: { type: "json", value: { sources: [] } },
				},
			],
		},
	],
	results: [RESULT],
};

const QUESTIONS: AskQuestion[] = [
	{
		question: "Which colour?",
		options: [{ label: "Red", recommended: true }, { label: "Blue" }],
	},
];

const PICKED_FIRST: AskAnswer = {
	kind: "answered",
	answers: [{ picked: [0], ownWords: null }],
};
const CLOSED: AskAnswer = { kind: "closed" };
const LEFT_TO_ALFY: AskAnswer = { kind: "left_to_alfy" };

function seedChat(chatId: string, userId: string, messageIds: string[]): void {
	const db = drizzle(sqlite, { schema });
	const now = new Date();
	db.insert(schema.conversations)
		.values({
			id: chatId,
			userId,
			title: "A chat",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	for (const id of messageIds) {
		db.insert(schema.messages)
			.values({
				id,
				conversationId: chatId,
				role: "assistant",
				content: "A reply",
				createdAt: now,
			})
			.run();
	}
}

beforeEach(() => {
	dbPath = `${tmpdir()}/alfyai-test-ask-questions-${randomUUID()}.db`;
	sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	migrate(drizzle(sqlite, { schema }), { migrationsFolder: "./drizzle" });
	streams.running.clear();

	const now = new Date();
	drizzle(sqlite, { schema })
		.insert(schema.users)
		.values(
			[USER, OTHER_USER].map((id) => ({
				id,
				email: `${id}@example.com`,
				passwordHash: "hash",
				createdAt: now,
				updatedAt: now,
			})),
		)
		.run();
	seedChat(CHAT, USER, ["m1", "m2", "m3", "m4", "m5"]);
});

afterEach(() => {
	vi.restoreAllMocks();
	sqlite.close();
	try {
		unlinkSync(dbPath);
	} catch {
		// best effort
	}
});

// --- helpers ----------------------------------------------------------------

/** A question as the tool records it: waiting, with no asking row yet. */
async function ask(
	where: { userId?: string; conversationId?: string } = {},
): Promise<string> {
	const { id } = await recordAskQuestion({
		userId: where.userId ?? USER,
		conversationId: where.conversationId ?? CHAT,
		toolCallId: `call-${randomUUID()}`,
		questions: QUESTIONS,
	});
	return id;
}

/** A question after its segment was saved: stamped with the asking row. */
async function askStamped(
	messageId: string,
	conversationId = CHAT,
): Promise<string> {
	const id = await ask({ conversationId });
	const stamped = await stampAskQuestion({
		userId: USER,
		questionId: id,
		assistantMessageId: messageId,
		capture: CAPTURE,
	});
	expect(stamped).toBe(true);
	return id;
}

const claim = (
	questionId: string,
	answer: AskAnswer,
	conversationId = CHAT,
): Promise<AskClaimResult> =>
	claimAskQuestion({ userId: USER, conversationId, questionId, answer });

/** Claims a question and hands back the token of the claim; the test fails if the claim loses. */
async function win(
	questionId: string,
	answer: AskAnswer,
	conversationId = CHAT,
): Promise<string> {
	const result = await claim(questionId, answer, conversationId);
	if (!result.ok) throw new Error(`the claim lost: ${result.reason}`);
	return result.claim;
}

const list = (conversationId = CHAT, userId = USER) =>
	listConversationAskQuestions({ userId, conversationId });

const release = (questionId: string, claimToken: string) =>
	releaseAskQuestion({ userId: USER, questionId, claim: claimToken });

const settle = (questionId: string, claimToken: string) =>
	settleAskQuestion({ userId: USER, questionId, claim: claimToken });

const hasWaiting = (conversationId = CHAT, userId = USER) =>
	hasWaitingAskQuestion({ userId, conversationId });

function rowOf(id: string): AskQuestionRow {
	const row = drizzle(sqlite, { schema })
		.select()
		.from(schema.askQuestions)
		.where(eq(schema.askQuestions.id, id))
		.get();
	if (!row) throw new Error(`no ask_questions row ${id}`);
	return row;
}

function rowCount(): number {
	const row = sqlite.prepare("SELECT COUNT(*) AS n FROM ask_questions").get();
	return (row as { n: number }).n;
}

/** A change made behind the store's back: a restart, a script, a bad row. */
function setColumn(id: string, column: string, value: string | null): void {
	sqlite
		.prepare(`UPDATE ask_questions SET ${column} = ? WHERE id = ?`)
		.run(value, id);
}

const answerOf = (id: string): unknown =>
	JSON.parse(rowOf(id).answerJson ?? "null");

// --- recording and stamping -------------------------------------------------

describe("recording and stamping a question", () => {
	it("records a waiting question with no message id, shown only while its chat's stream runs", async () => {
		const id = await ask();

		const row = rowOf(id);
		expect(row).toMatchObject({
			userId: USER,
			conversationId: CHAT,
			assistantMessageId: null,
			status: "waiting",
			answerJson: null,
			resumeJson: null,
			answeredAt: null,
			settledAt: null,
		});
		expect(JSON.parse(row.questionsJson)).toEqual(QUESTIONS);
		expect(row.createdAt).toBeInstanceOf(Date);

		// No stream runs for the chat: the question belongs to a reply that is
		// not being written, so nobody is shown it.
		expect(await list()).toEqual([]);

		// A stream of another chat does not show it either.
		streams.running.set(`${USER}:chat-other`, "stream-other");
		expect(await list()).toEqual([]);

		streams.running.set(`${USER}:${CHAT}`, "stream-1");
		const shown = await list();
		expect(shown).toMatchObject([
			{
				id,
				conversationId: CHAT,
				assistantMessageId: null,
				toolCallId: row.toolCallId,
				questions: QUESTIONS,
				status: "waiting",
				answer: null,
			},
		]);
		// the DTO's time is milliseconds, the column's seconds
		expect(shown[0].createdAt).toBe(row.createdAt.getTime());

		// the reply ends and its stream is gone: the question is gone from the list
		streams.running.clear();
		expect(await list()).toEqual([]);
	});

	it("stamps the message id and the capture in one update, once", async () => {
		const id = await ask();

		const first = await stampAskQuestion({
			userId: USER,
			questionId: id,
			assistantMessageId: "m1",
			capture: CAPTURE,
		});
		expect(first).toBe(true);
		const stamped = rowOf(id);
		expect(stamped).toMatchObject({
			assistantMessageId: "m1",
			status: "waiting",
		});
		expect(readAskCapture(stamped)).toEqual(CAPTURE);

		// A second stamp (a save that ran twice) changes neither field.
		const second = await stampAskQuestion({
			userId: USER,
			questionId: id,
			assistantMessageId: "m2",
			capture: { v: 1, messages: [], results: [] },
		});
		expect(second).toBe(false);
		expect(rowOf(id)).toMatchObject({ assistantMessageId: "m1" });
		expect(readAskCapture(rowOf(id))).toEqual(CAPTURE);
	});

	it("stamps only the person's own question, and only while it waits", async () => {
		const id = await ask();
		const stamp = (userId: string, questionId: string) =>
			stampAskQuestion({
				userId,
				questionId,
				assistantMessageId: "m1",
				capture: CAPTURE,
			});

		expect(await stamp(OTHER_USER, id)).toBe(false);
		expect(await stamp(USER, "no-such-question")).toBe(false);
		expect(rowOf(id)).toMatchObject({
			assistantMessageId: null,
			resumeJson: null,
		});

		// A question the turn already discarded is not brought back by a late save.
		await discardAskQuestion({ userId: USER, questionId: id });
		expect(await stamp(USER, id)).toBe(false);
		expect(rowOf(id)).toMatchObject({
			status: "discarded",
			assistantMessageId: null,
			resumeJson: null,
		});
	});

	it("reads a question back only for its own person and chat", async () => {
		const id = await askStamped("m1");

		expect(
			await getAskQuestion({
				userId: USER,
				conversationId: CHAT,
				questionId: id,
			}),
		).toMatchObject({ id, status: "waiting", assistantMessageId: "m1" });
		expect(
			await getAskQuestion({
				userId: OTHER_USER,
				conversationId: CHAT,
				questionId: id,
			}),
		).toBeNull();
		expect(
			await getAskQuestion({
				userId: USER,
				conversationId: "chat-other",
				questionId: id,
			}),
		).toBeNull();
		expect(
			await getAskQuestion({
				userId: USER,
				conversationId: CHAT,
				questionId: "no-such-question",
			}),
		).toBeNull();
	});
});

// --- the claim --------------------------------------------------------------

describe("claiming a question", () => {
	it("lets one of two claims win", async () => {
		const id = await askStamped("m1");
		const ids = { userId: USER, conversationId: CHAT, questionId: id };

		const [a, b] = await Promise.all([
			claimAskQuestion({ ...ids, answer: PICKED_FIRST }),
			claimAskQuestion({ ...ids, answer: CLOSED }),
		]);

		expect([a.ok, b.ok].sort()).toEqual([false, true]);
		expect(a.ok ? b : a).toEqual({ ok: false, reason: "not_waiting" });
		// the row holds the answer of the claim that won, and only that one
		expect(answerOf(id)).toEqual(a.ok ? PICKED_FIRST : CLOSED);
		expect(rowOf(id).status).toBe("answering");
		// the winner, and only the winner, is handed the token of its claim
		expect(a.ok ? a : b).toMatchObject({ ok: true, claim: expect.any(String) });
		expect(a.ok ? b : a).not.toHaveProperty("claim");
	});

	it("hands the winner the claimed row, with the answer, the time and the capture", async () => {
		const id = await askStamped("m1");

		const won = await claim(id, PICKED_FIRST);

		expect(won).toMatchObject({
			ok: true,
			claim: expect.any(String),
			row: { id, status: "answering", assistantMessageId: "m1" },
		});
		const row = rowOf(id);
		expect(row.status).toBe("answering");
		expect(answerOf(id)).toEqual(PICKED_FIRST);
		expect(row.answeredAt).toBeInstanceOf(Date);
		// kept until the segment that answers it is saved: a resume that dies needs it
		expect(readAskCapture(row)).toEqual(CAPTURE);
		if (won.ok) expect(readAskCapture(won.row)).toEqual(CAPTURE);
	});

	it("claims nothing unstamped", async () => {
		const id = await ask();

		expect(await claim(id, PICKED_FIRST)).toEqual({
			ok: false,
			reason: "not_waiting",
		});
		expect(rowOf(id)).toMatchObject({ status: "waiting", answerJson: null });
	});

	it("tells a question that is not there from one that is not waiting", async () => {
		const id = await askStamped("m1");
		seedChat("chat-2", USER, ["c2-m1"]);

		// not there: no such id, another chat's, another person's
		const notFound = { ok: false, reason: "not_found" };
		expect(await claim("no-such-question", PICKED_FIRST)).toEqual(notFound);
		expect(
			await claimAskQuestion({
				userId: USER,
				conversationId: "chat-2",
				questionId: id,
				answer: PICKED_FIRST,
			}),
		).toEqual(notFound);
		expect(
			await claimAskQuestion({
				userId: OTHER_USER,
				conversationId: CHAT,
				questionId: id,
				answer: PICKED_FIRST,
			}),
		).toEqual(notFound);
		expect(rowOf(id)).toMatchObject({ status: "waiting", answerJson: null });

		// there, but past waiting: answered, and discarded
		await settle(id, await win(id, PICKED_FIRST));
		expect(await claim(id, CLOSED)).toEqual({
			ok: false,
			reason: "not_waiting",
		});
		const discarded = await ask();
		await discardAskQuestion({ userId: USER, questionId: discarded });
		expect(await claim(discarded, CLOSED)).toEqual({
			ok: false,
			reason: "not_waiting",
		});
	});

	it("never lets a second claim undo a first whose stream has not started", async () => {
		const id = await askStamped("m1");

		const first = await claim(id, PICKED_FIRST);
		expect(first.ok).toBe(true);

		// The route prepares the turn between the claim and the stream, so the
		// registry still says nothing for the chat when the second device answers.
		expect(streams.running.size).toBe(0);
		const second = await claim(id, CLOSED);

		expect(second).toEqual({ ok: false, reason: "not_waiting" });
		expect(rowOf(id).status).toBe("answering");
		expect(answerOf(id)).toEqual(PICKED_FIRST);
	});

	it("releases a stale answering question before a claim when no resume is live for it (a restart)", async () => {
		const id = await askStamped("m1");
		// The row says answering, but this process holds no resume for it: it was
		// set so directly, not through a claim, as a restart leaves it.
		setColumn(id, "status", "answering");
		setColumn(id, "answer_json", JSON.stringify(PICKED_FIRST));

		const retried = await claim(id, CLOSED);

		expect(retried).toMatchObject({
			ok: true,
			row: { id, status: "answering" },
		});
		expect(answerOf(id)).toEqual(CLOSED);
	});

	it("lets one of two claims win on a question a restart left answering", async () => {
		const id = await askStamped("m1");
		setColumn(id, "status", "answering");
		setColumn(id, "answer_json", JSON.stringify(PICKED_FIRST));
		const ids = { userId: USER, conversationId: CHAT, questionId: id };

		const [a, b] = await Promise.all([
			claimAskQuestion({ ...ids, answer: LEFT_TO_ALFY }),
			claimAskQuestion({ ...ids, answer: CLOSED }),
		]);

		// The first releases the stale row and wins; the second sees a resume
		// live for it and must not release it again.
		expect([a.ok, b.ok].sort()).toEqual([false, true]);
		expect(a.ok ? b : a).toEqual({ ok: false, reason: "not_waiting" });
		expect(answerOf(id)).toEqual(a.ok ? LEFT_TO_ALFY : CLOSED);
	});

	it("refuses a row the list cannot read, and throws on an answer that does not parse", async () => {
		const badQuestions = await askStamped("m1");
		const badAnswer = await askStamped("m2");
		const unreadableAnswer = JSON.stringify({
			kind: "answered",
			answers: "nope",
		});
		setColumn(badQuestions, "questions_json", "{ not json");
		// a waiting question whose last answer cannot be read
		setColumn(badAnswer, "answer_json", unreadableAnswer);

		// The list shows no card for either, so neither can be answered; and
		// nothing is written to them.
		for (const id of [badQuestions, badAnswer]) {
			expect(await claim(id, PICKED_FIRST)).toEqual({
				ok: false,
				reason: "not_waiting",
			});
			expect(rowOf(id).status).toBe("waiting");
		}
		expect(rowOf(badQuestions).answerJson).toBeNull();
		expect(rowOf(badAnswer).answerJson).toBe(unreadableAnswer);

		// An answer that parseAskAnswer rejects is a caller's bug (the route passes
		// the answer checkAskAnswer returned): it throws, and touches nothing.
		const id = await askStamped("m3");
		const rejected = [
			null,
			{ kind: "someone" },
			{ kind: "answered", answers: [] },
			{
				kind: "answered",
				answers: [{ picked: [0], ownWords: "x".repeat(501) }],
			},
		];
		for (const answer of rejected) {
			await expect(claim(id, answer as unknown as AskAnswer)).rejects.toThrow();
		}
		expect(rowOf(id)).toMatchObject({ status: "waiting", answerJson: null });
		// and none of them left a claim behind: a row a restart left answering is
		// still released by the next claim, which then wins
		setColumn(id, "status", "answering");
		expect((await claim(id, PICKED_FIRST)).ok).toBe(true);
	});

	it("writes the answer the way it will be read back", async () => {
		const id = await askStamped("m1");
		const padded: AskAnswer = {
			kind: "answered",
			answers: [{ picked: [], ownWords: "  Green, please  " }],
		};
		const trimmed: AskAnswer = {
			kind: "answered",
			answers: [{ picked: [], ownWords: "Green, please" }],
		};

		expect((await claim(id, padded)).ok).toBe(true);

		expect(answerOf(id)).toEqual(trimmed);
		expect(await list()).toMatchObject([
			{ id, status: "answering", answer: trimmed },
		]);
	});
});

// --- whether an answer has anything left to win ----------------------------

describe("whether a question is taken", () => {
	const taken = (questionId: string, conversationId = CHAT, userId = USER) =>
		isAskQuestionTaken({ userId, conversationId, questionId });

	it("is taken while a resume of this process runs it, and once it is answered or closed, and the claim would say the same", async () => {
		const answered = await askStamped("m1");
		const closed = await askStamped("m2");
		expect(await taken(answered)).toBe(false);

		// answering, with the claim that started the resume live
		const answeredToken = await win(answered, PICKED_FIRST);
		expect(await taken(answered)).toBe(true);
		expect(await claim(answered, CLOSED)).toEqual({
			ok: false,
			reason: "not_waiting",
		});

		// answered
		await settle(answered, answeredToken);
		expect(rowOf(answered).status).toBe("answered");
		expect(await taken(answered)).toBe(true);
		expect(await claim(answered, CLOSED)).toEqual({
			ok: false,
			reason: "not_waiting",
		});

		// closed (the X)
		await settle(closed, await win(closed, CLOSED));
		expect(rowOf(closed).status).toBe("closed");
		expect(await taken(closed)).toBe(true);
		expect(await claim(closed, PICKED_FIRST)).toEqual({
			ok: false,
			reason: "not_waiting",
		});
	});

	it("is not taken when a restart left the row answering with no resume behind it, and asking leaves the row as it was", async () => {
		const id = await askStamped("m1");
		// Set so directly, not through a claim: this process holds no resume for it.
		setColumn(id, "status", "answering");
		setColumn(id, "answer_json", JSON.stringify(PICKED_FIRST));

		expect(await taken(id)).toBe(false);

		// Unlike the claim, which releases such a row before it wins it, the check
		// reads: the row says what it said, and the claim still wins afterwards.
		expect(rowOf(id).status).toBe("answering");
		expect(answerOf(id)).toEqual(PICKED_FIRST);
		expect((await claim(id, CLOSED)).ok).toBe(true);
		expect(await taken(id)).toBe(true);
	});

	it("is not taken once the claim was given back", async () => {
		const id = await askStamped("m1");
		const token = await win(id, PICKED_FIRST);
		expect(await taken(id)).toBe(true);

		await release(id, token);

		expect(rowOf(id).status).toBe("waiting");
		expect(await taken(id)).toBe(false);
	});

	it("is not taken while the question waits, unsaved or discarded, and not for what is not the person's own", async () => {
		const waiting = await askStamped("m1");
		const unstamped = await ask();
		const discarded = await ask();
		await discardAskQuestion({ userId: USER, questionId: discarded });
		seedChat("chat-2", USER, ["c2-m1"]);
		const claimed = await askStamped("m2");
		await win(claimed, PICKED_FIRST);

		expect(await taken(waiting)).toBe(false);
		expect(await taken(unstamped)).toBe(false);
		expect(await taken(discarded)).toBe(false);
		expect(await taken("no-such-question")).toBe(false);
		// a taken question, asked as another chat's or another person's: not there
		expect(await taken(claimed)).toBe(true);
		expect(await taken(claimed, "chat-2")).toBe(false);
		expect(await taken(claimed, CHAT, OTHER_USER)).toBe(false);
	});
});

// --- release and settle -----------------------------------------------------

describe("releasing and settling a claimed question", () => {
	it("puts a released question back to waiting with its answer, which the list reports", async () => {
		const id = await askStamped("m1");
		const token = await win(id, PICKED_FIRST);
		expect(await list()).toMatchObject([
			{ id, status: "answering", answer: PICKED_FIRST },
		]);

		expect(await release(id, token)).toBe(true);

		expect(rowOf(id).status).toBe("waiting");
		expect(await list()).toMatchObject([
			{ id, status: "waiting", answer: PICKED_FIRST },
		]);
		// the capture is kept for the next try
		expect(readAskCapture(rowOf(id))).toEqual(CAPTURE);
		// and the card can be answered again, differently
		expect((await claim(id, CLOSED)).ok).toBe(true);
		expect(answerOf(id)).toEqual(CLOSED);
	});

	it("reads an answering question with no live resume as waiting, with its answer", async () => {
		const id = await askStamped("m1");
		setColumn(id, "status", "answering");
		setColumn(id, "answer_json", JSON.stringify(PICKED_FIRST));

		expect(await list()).toMatchObject([
			{ id, status: "waiting", answer: PICKED_FIRST },
		]);
		// reading changes nothing: it is the claim that releases
		expect(rowOf(id).status).toBe("answering");
	});

	it("releases only for the claim that holds the question, and only the person's own", async () => {
		const waiting = await askStamped("m1");
		const unstamped = await ask();

		// no claim holds a question that was never claimed
		expect(await release(waiting, "no-such-claim")).toBe(false);
		expect(await release(unstamped, "no-such-claim")).toBe(false);
		expect(await release("no-such-question", "no-such-claim")).toBe(false);

		// A restart left a row answering and nothing holds it: a call that carries
		// no claim at all must not match the empty place in the map.
		const stale = await askStamped("m2");
		setColumn(stale, "status", "answering");
		expect(
			await releaseAskQuestion({
				userId: USER,
				questionId: stale,
				claim: undefined as unknown as string,
			}),
		).toBe(false);
		expect(rowOf(stale).status).toBe("answering");

		// the holder's UPDATE is the person's own: another person's call changes no row
		const token = await win(waiting, PICKED_FIRST);
		expect(
			await releaseAskQuestion({
				userId: OTHER_USER,
				questionId: waiting,
				claim: token,
			}),
		).toBe(false);
		expect(rowOf(waiting).status).toBe("answering");
	});

	it("never lets a second release for one claim undo a later claim", async () => {
		const id = await askStamped("m1");
		const first = await win(id, PICKED_FIRST);
		expect(await release(id, first)).toBe(true);
		const second = await win(id, CLOSED);

		// the first claim's release lands again: a retry, a late error path
		expect(await release(id, first)).toBe(false);

		// The second claim is as it was: its row answering with its answer, and a
		// third claim still loses.
		expect(rowOf(id).status).toBe("answering");
		expect(answerOf(id)).toEqual(CLOSED);
		expect(await claim(id, LEFT_TO_ALFY)).toEqual({
			ok: false,
			reason: "not_waiting",
		});
		// and it still owns its own release
		expect(await release(id, second)).toBe(true);
		expect(rowOf(id).status).toBe("waiting");
	});

	it("leaves another claim's row alone when a superseded attempt settles", async () => {
		const id = await askStamped("m1");
		const first = await win(id, PICKED_FIRST);
		expect(await release(id, first)).toBe(true);
		const second = await win(id, CLOSED);

		expect(await settle(id, first)).toBeNull();

		// the row keeps the second claim: answering, its answer, its capture
		expect(rowOf(id)).toMatchObject({ status: "answering", settledAt: null });
		expect(answerOf(id)).toEqual(CLOSED);
		expect(readAskCapture(rowOf(id))).toEqual(CAPTURE);
		expect(await claim(id, LEFT_TO_ALFY)).toEqual({
			ok: false,
			reason: "not_waiting",
		});
		// and the second claim settles it, as the X
		expect(await settle(id, second)).toMatchObject({ status: "closed" });
	});

	it("leaves exactly one live claim when a release races a claim", async () => {
		const races: Array<(id: string, first: string) => Promise<AskClaimResult>> =
			[
				// the release starts first, the claim right behind it
				async (id, first) => {
					const [, second] = await Promise.all([
						release(id, first),
						claim(id, CLOSED),
					]);
					return second;
				},
				// the claim starts first, while the first claim is still live
				async (id, first) => {
					const [second] = await Promise.all([
						claim(id, CLOSED),
						release(id, first),
					]);
					return second;
				},
			];

		for (const [n, race] of races.entries()) {
			const id = await askStamped(`m${n + 1}`);
			const first = await win(id, PICKED_FIRST);

			const second = await race(id, first);
			const third = await claim(id, LEFT_TO_ALFY);

			// Either order is legitimate. Never both: two live claims would start two
			// resumes for one question.
			const winners = [second, third].filter((result) => result.ok);
			expect(winners).toHaveLength(1);
			expect(rowOf(id).status).toBe("answering");
			expect(answerOf(id)).toEqual(second.ok ? CLOSED : LEFT_TO_ALFY);
		}
	});

	it("leaves a settled question settled when a settle races a claim", async () => {
		const races: Array<(id: string, first: string) => Promise<AskClaimResult>> =
			[
				async (id, first) => {
					const [, second] = await Promise.all([
						settle(id, first),
						claim(id, CLOSED),
					]);
					return second;
				},
				async (id, first) => {
					const [second] = await Promise.all([
						claim(id, CLOSED),
						settle(id, first),
					]);
					return second;
				},
			];

		for (const [n, race] of races.entries()) {
			const id = await askStamped(`m${n + 1}`);
			const first = await win(id, PICKED_FIRST);

			const second = await race(id, first);

			// The settle is the first claim's to make and the question is answered
			// for good: the racing claim never wins, in either order.
			expect(second).toEqual({ ok: false, reason: "not_waiting" });
			expect(rowOf(id).status).toBe("answered");
			expect(answerOf(id)).toEqual(PICKED_FIRST);
		}
	});

	it("settles an answer as answered and the X as closed, and drops the capture", async () => {
		const answered = await askStamped("m1");
		const closed = await askStamped("m2");
		const leftToAlfy = await askStamped("m3");
		const answeredClaim = await win(answered, PICKED_FIRST);
		const closedClaim = await win(closed, CLOSED);
		const leftToAlfyClaim = await win(leftToAlfy, LEFT_TO_ALFY);

		const a = await settle(answered, answeredClaim);
		const c = await settle(closed, closedClaim);
		const l = await settle(leftToAlfy, leftToAlfyClaim);

		expect(a).toMatchObject({
			id: answered,
			status: "answered",
			resumeJson: null,
		});
		expect(c).toMatchObject({ id: closed, status: "closed", resumeJson: null });
		expect(l).toMatchObject({
			id: leftToAlfy,
			status: "answered",
			resumeJson: null,
		});
		for (const id of [answered, closed, leftToAlfy]) {
			const row = rowOf(id);
			expect(row.resumeJson).toBeNull();
			expect(readAskCapture(row)).toBeNull();
			expect(row.settledAt).toBeInstanceOf(Date);
			expect(row.answeredAt).toBeInstanceOf(Date);
		}
		// the answer stays on the row: the folded line and the ask call's record read it
		expect(answerOf(answered)).toEqual(PICKED_FIRST);
		expect(answerOf(closed)).toEqual(CLOSED);
		expect(await list()).toMatchObject([
			{ id: answered, status: "answered", answer: PICKED_FIRST },
			{ id: closed, status: "closed", answer: CLOSED },
			{ id: leftToAlfy, status: "answered", answer: LEFT_TO_ALFY },
		]);

		// nothing is settled twice, and nothing that was never claimed
		expect(await settle(answered, answeredClaim)).toBeNull();
		const waiting = await askStamped("m4");
		expect(await settle(waiting, "no-such-claim")).toBeNull();
		expect(rowOf(waiting)).toMatchObject({
			status: "waiting",
			settledAt: null,
		});
		expect(
			await settleAskQuestion({
				userId: OTHER_USER,
				questionId: waiting,
				claim: "no-such-claim",
			}),
		).toBeNull();
	});

	it("lets the holder of the live claim clear it on release and on settle, whether or not its UPDATE changed a row", async () => {
		const id = await askStamped("m1");

		// release: the row is changed behind the store's back, so it changes nothing
		const first = await win(id, PICKED_FIRST);
		setColumn(id, "status", "waiting");
		expect(await release(id, first)).toBe(false);
		// The claim was cleared anyway: a row that says answering with no resume
		// live for it is released by the next claim, which then wins.
		setColumn(id, "status", "answering");
		const second = await win(id, CLOSED);

		// settle: the same
		setColumn(id, "status", "waiting");
		expect(await settle(id, second)).toBeNull();
		setColumn(id, "status", "answering");
		expect((await claim(id, PICKED_FIRST)).ok).toBe(true);
		expect(answerOf(id)).toEqual(PICKED_FIRST);
	});

	it("changes nothing when a call holds no live claim", async () => {
		const id = await askStamped("m1");
		const token = await win(id, PICKED_FIRST);

		// an unknown claim, and another question's: neither releases or settles
		expect(await release(id, "no-such-claim")).toBe(false);
		expect(await settle(id, "no-such-claim")).toBeNull();
		const other = await askStamped("m2");
		expect(await release(id, await win(other, CLOSED))).toBe(false);
		expect(rowOf(id)).toMatchObject({ status: "answering", settledAt: null });
		expect(rowOf(other).status).toBe("answering");

		// and the live claim was left in place by all of them: nothing else wins
		expect(await claim(id, CLOSED)).toEqual({
			ok: false,
			reason: "not_waiting",
		});
		expect(await settle(id, token)).toMatchObject({ id, status: "answered" });
	});
});

// --- discarding -------------------------------------------------------------

describe("discarding a question", () => {
	it("discards only unstamped waiting questions; the turn-start sweep clears a chat's leftovers", async () => {
		const stamped = await askStamped("m1");
		const answering = await askStamped("m2");
		await claim(answering, PICKED_FIRST);
		const lone = await ask();

		// a stamped question, waiting or answering, is not a turn's to discard
		await discardAskQuestion({ userId: USER, questionId: stamped });
		await discardAskQuestion({ userId: USER, questionId: answering });
		expect(rowOf(stamped)).toMatchObject({
			status: "waiting",
			settledAt: null,
		});
		expect(readAskCapture(rowOf(stamped))).toEqual(CAPTURE);
		expect(rowOf(answering).status).toBe("answering");
		// nor is another person's
		await discardAskQuestion({ userId: OTHER_USER, questionId: lone });
		expect(rowOf(lone).status).toBe("waiting");

		// an unstamped one is: marked discarded, settled, and shown to nobody
		streams.running.set(`${USER}:${CHAT}`, "stream-1");
		expect((await list()).map((q) => q.id)).toContain(lone);
		await discardAskQuestion({ userId: USER, questionId: lone });
		expect(rowOf(lone)).toMatchObject({
			status: "discarded",
			resumeJson: null,
		});
		expect(rowOf(lone).settledAt).toBeInstanceOf(Date);
		expect((await list()).map((q) => q.id)).not.toContain(lone);

		// the sweep at a turn's start: this chat's unstamped leftovers only
		seedChat("chat-2", USER, ["c2-m1"]);
		const leftoverA = await ask();
		const leftoverB = await ask();
		const elsewhere = await ask({ conversationId: "chat-2" });
		const theirs = await ask({ userId: OTHER_USER, conversationId: CHAT });
		expect(
			await discardStaleAskQuestions({ userId: USER, conversationId: CHAT }),
		).toBe(2);
		for (const id of [leftoverA, leftoverB]) {
			expect(rowOf(id)).toMatchObject({
				status: "discarded",
				resumeJson: null,
			});
			expect(rowOf(id).settledAt).toBeInstanceOf(Date);
		}
		expect(rowOf(stamped).status).toBe("waiting");
		expect(rowOf(answering).status).toBe("answering");
		expect(rowOf(elsewhere).status).toBe("waiting");
		expect(rowOf(theirs).status).toBe("waiting");

		// nothing is left to sweep
		expect(
			await discardStaleAskQuestions({ userId: USER, conversationId: CHAT }),
		).toBe(0);
	});
});

// --- the lists --------------------------------------------------------------

describe("the lists", () => {
	it("lists a chat's questions in the order they were asked, for their person only", async () => {
		const first = await askStamped("m1");
		const second = await askStamped("m2");
		const third = await askStamped("m3");
		seedChat("chat-2", USER, ["c2-m1"]);
		await askStamped("c2-m1", "chat-2");

		expect((await list()).map((q) => q.id)).toEqual([first, second, third]);
		expect(await list(CHAT, OTHER_USER)).toEqual([]);
		expect((await list("chat-2")).map((q) => q.conversationId)).toEqual([
			"chat-2",
		]);
	});

	it("skips a question it cannot read, logging its row id and none of its text", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const readable = await askStamped("m1");
		const brokenJson = await askStamped("m2");
		const noQuestions = await askStamped("m3");
		const brokenAnswer = await askStamped("m4");
		setColumn(brokenJson, "questions_json", "{ SECRET-QUESTION-TEXT");
		setColumn(noQuestions, "questions_json", "[]");
		setColumn(
			brokenAnswer,
			"answer_json",
			JSON.stringify({ kind: "answered", answers: "SECRET-ANSWER-TEXT" }),
		);

		// one unreadable row must not fail the person's whole list
		const shown = await list();

		expect(shown.map((q) => q.id)).toEqual([readable]);
		const logged = JSON.stringify(warn.mock.calls);
		for (const id of [brokenJson, noQuestions, brokenAnswer]) {
			expect(logged).toContain(id);
		}
		expect(logged).not.toContain(readable);
		expect(logged).not.toContain("SECRET");
	});

	it("goes quiet about a row nobody would see", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const unstamped = await ask();
		setColumn(unstamped, "questions_json", "not json");
		const discarded = await ask();
		setColumn(discarded, "questions_json", "not json");
		await discardAskQuestion({ userId: USER, questionId: discarded });

		expect(await list()).toEqual([]);

		expect(warn).not.toHaveBeenCalled();
	});

	it("marks for the sidebar a stamped waiting question, and an answering one only when no resume is live for it", async () => {
		for (const chat of ["chat-2", "chat-3", "chat-4", "chat-5", "chat-6"]) {
			seedChat(chat, USER, [`${chat}-m1`]);
		}
		await askStamped("m1");
		await ask({ conversationId: "chat-2" });
		const live = await askStamped("chat-3-m1", "chat-3");
		const stale = await askStamped("chat-4-m1", "chat-4");
		const settled = await askStamped("chat-5-m1", "chat-5");
		const discarded = await ask({ conversationId: "chat-6" });
		await discardAskQuestion({ userId: USER, questionId: discarded });
		const liveClaim = await win(live, PICKED_FIRST, "chat-3");
		setColumn(stale, "status", "answering");
		await settle(settled, await win(settled, PICKED_FIRST, "chat-5"));
		const everyChat = [CHAT, "chat-2", "chat-3", "chat-4", "chat-5", "chat-6"];

		// stamped and waiting (CHAT), and answering with no resume live (chat-4);
		// not unstamped (chat-2), not answering with a resume live (chat-3), not
		// answered (chat-5), not discarded (chat-6)
		expect(
			await listWaitingAskConversationIds({
				userId: USER,
				conversationIds: everyChat,
			}),
		).toEqual(new Set([CHAT, "chat-4"]));

		// only the chats asked about, and only for their person
		expect(
			await listWaitingAskConversationIds({
				userId: USER,
				conversationIds: ["chat-4", "chat-3"],
			}),
		).toEqual(new Set(["chat-4"]));
		expect(
			await listWaitingAskConversationIds({
				userId: OTHER_USER,
				conversationIds: everyChat,
			}),
		).toEqual(new Set());
		expect(
			await listWaitingAskConversationIds({
				userId: USER,
				conversationIds: [],
			}),
		).toEqual(new Set());

		// a resume that ends without landing puts its chat back on the sidebar
		await release(live, liveClaim);
		expect(
			await listWaitingAskConversationIds({
				userId: USER,
				conversationIds: everyChat,
			}),
		).toEqual(new Set([CHAT, "chat-3", "chat-4"]));
	});

	it("refuses while a stamped question waits or answers", async () => {
		const id = await ask();
		// not yet saved with its reply: the reply is still being written
		expect(await hasWaiting()).toBe(false);

		await stampAskQuestion({
			userId: USER,
			questionId: id,
			assistantMessageId: "m1",
			capture: CAPTURE,
		});
		expect(await hasWaiting()).toBe(true);
		// the question is the chat's, and the person's
		expect(await hasWaiting("chat-other")).toBe(false);
		expect(await hasWaiting(CHAT, OTHER_USER)).toBe(false);

		// answering, with its resume live: the reply is on its way, still no new message
		const first = await win(id, PICKED_FIRST);
		expect(await hasWaiting()).toBe(true);

		// answering, with no resume live for it (a restart): the card is back, still refused
		await release(id, first);
		setColumn(id, "status", "answering");
		expect(await hasWaiting()).toBe(true);

		await settle(id, await win(id, CLOSED));
		expect(await hasWaiting()).toBe(false);

		const discarded = await ask();
		await discardAskQuestion({ userId: USER, questionId: discarded });
		expect(await hasWaiting()).toBe(false);
	});

	it("counts only the questions the list shows: a stamped one it cannot read refuses nothing and marks nothing", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		seedChat("chat-2", USER, ["c2-m1"]);
		seedChat("chat-3", USER, ["c3-m1"]);
		const badQuestions = await askStamped("m1");
		const badAnswer = await askStamped("c2-m1", "chat-2");
		const staleBad = await askStamped("c3-m1", "chat-3");
		setColumn(badQuestions, "questions_json", "{ not json");
		setColumn(
			badAnswer,
			"answer_json",
			JSON.stringify({ kind: "answered", answers: "nope" }),
		);
		// answering with no resume live, which reads as waiting, with no questions
		setColumn(staleBad, "status", "answering");
		setColumn(staleBad, "questions_json", "[]");
		const chats = [CHAT, "chat-2", "chat-3"];

		// the list shows no card in any of the three chats, and says so in the log
		for (const chat of chats) expect(await list(chat)).toEqual([]);
		expect(warn).toHaveBeenCalledTimes(3);
		warn.mockClear();

		// so none of them refuses a new message
		for (const chat of chats) expect(await hasWaiting(chat)).toBe(false);
		// and none is marked in the sidebar
		expect(
			await listWaitingAskConversationIds({
				userId: USER,
				conversationIds: chats,
			}),
		).toEqual(new Set());
		// The counts are asked on every send and every sidebar load, so they stay
		// quiet: the list is where an unreadable row is reported.
		expect(warn).not.toHaveBeenCalled();

		// a readable question beside an unreadable one still shows, refuses and marks
		const good = await askStamped("m2");
		expect((await list()).map((q) => q.id)).toEqual([good]);
		expect(await hasWaiting()).toBe(true);
		expect(
			await listWaitingAskConversationIds({
				userId: USER,
				conversationIds: chats,
			}),
		).toEqual(new Set([CHAT]));
	});
});

// --- the capture ------------------------------------------------------------

describe("reading a capture back", () => {
	it("reads a capture back only when it is whole", async () => {
		const id = await ask();
		const row = rowOf(id);
		const read = (resumeJson: string | null) =>
			readAskCapture({ ...row, resumeJson });

		// nothing stored: a waiting question not yet saved, or one already settled
		expect(read(null)).toBeNull();

		const whole = { v: 1, messages: [], results: [] };
		expect(read(JSON.stringify(whole))).toEqual(whole);
		expect(read(JSON.stringify(CAPTURE))).toEqual(CAPTURE);

		const broken = [
			"not json",
			"null",
			"[]",
			JSON.stringify({ ...whole, v: 2 }),
			JSON.stringify({ ...whole, messages: "no" }),
			JSON.stringify({ ...whole, results: {} }),
			JSON.stringify({ ...whole, messages: [{ role: "robot", content: "x" }] }),
			JSON.stringify({ ...whole, messages: [{ role: "user", content: 7 }] }),
			JSON.stringify({ ...whole, results: [{ toolCallId: "call-1" }] }),
			JSON.stringify({
				...whole,
				results: [{ ...RESULT, localDistilled: "yes" }],
			}),
			JSON.stringify({
				...whole,
				results: [{ ...RESULT, digest: { ok: true } }],
			}),
			JSON.stringify({
				...whole,
				results: [
					{ ...RESULT, digest: { ok: true, summary: "s", sources: [{}] } },
				],
			}),
		];
		for (const json of broken) expect(read(json)).toBeNull();
	});
});

// --- cascades ---------------------------------------------------------------

describe("what the rows go with", () => {
	it("goes with the asking row and with the chat", async () => {
		seedChat("chat-2", USER, ["c2-m1"]);
		const first = await askStamped("m1");
		const second = await askStamped("m2");
		const unstamped = await ask({ conversationId: "chat-2" });
		expect(rowCount()).toBe(3);

		// the asking message is deleted: its question goes, the others stay
		sqlite.prepare("DELETE FROM messages WHERE id = ?").run("m1");
		expect(rowCount()).toBe(2);
		expect(
			sqlite.prepare("SELECT id FROM ask_questions WHERE id = ?").get(first),
		).toBeUndefined();

		// the chat is deleted: its stamped and its unstamped questions go
		sqlite.prepare("DELETE FROM conversations WHERE id = ?").run(CHAT);
		expect(
			sqlite.prepare("SELECT id FROM ask_questions WHERE id = ?").get(second),
		).toBeUndefined();
		expect(rowOf(unstamped).conversationId).toBe("chat-2");
		sqlite.prepare("DELETE FROM conversations WHERE id = ?").run("chat-2");
		expect(rowCount()).toBe(0);
	});

	it("goes with the person", async () => {
		await askStamped("m1");
		await ask();
		expect(rowCount()).toBe(2);

		sqlite.prepare("DELETE FROM users WHERE id = ?").run(USER);

		expect(rowCount()).toBe(0);
	});
});
