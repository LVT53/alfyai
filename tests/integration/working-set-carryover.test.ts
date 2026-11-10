// What the working set keeps of a document the person is working on.
//
// After a turn that works on a document, the working set is what carries it into
// the next turn's prompt when that turn's message does not name it ("And what about
// the second paragraph?"). Whether it is carried must depend on what the person is
// doing with the document, never on when the file was last written.
//
// It did depend on that. `scoreCandidate` multiplied every signal by
// exp(-0.011 * age) with the age in SECONDS, so a document written more than about
// two minutes before the turn ended fell under the cut of 20 and went "cooling",
// however clearly the turn had been about it. An hour later, or a day, the next
// turn's prompt did not hold the document the person had open.
//
// The real functions throughout, over the worker's migrated SQLite file: the
// working set is refreshed where a turn ends (`refreshConversationWorkingSet`, with
// the parameters the turn's finalization passes), and the next turn's prompt is built
// by `buildConstructedContext`. Only the clock is faked (`Date` alone), so a
// document can be an hour old without being backdated. Every world has its own user
// and its own marker word: the cross-conversation search would otherwise return a
// copy of the document from another test's conversation and read as a hit.
//
// The messages are English because the wording that makes an open document the
// turn's focus is read from English words; that gate is not what is tested here.
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { db } from "../../src/lib/server/db";
import {
	artifacts,
	conversations,
	conversationWorkingSetItems,
	users,
} from "../../src/lib/server/db/schema";
import { buildConstructedContext } from "../../src/lib/server/services/chat-turn/context-selection";
import { createConversation } from "../../src/lib/server/services/conversations";
import { createGeneratedOutputArtifact } from "../../src/lib/server/services/knowledge/capsules";
import {
	refreshConversationWorkingSet,
	selectWorkingSetArtifactsForPrompt,
} from "../../src/lib/server/services/knowledge/context";
import { createArtifact } from "../../src/lib/server/services/knowledge/store/core";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-11-10T08:00:00.000Z");

const createdUserIds: string[] = [];
let worlds = 0;

beforeEach(() => {
	// The working-document summary line each turn logs is not what is tested.
	vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

afterAll(async () => {
	if (createdUserIds.length === 0) return;
	await db.delete(artifacts).where(inArray(artifacts.userId, createdUserIds));
	await db
		.delete(conversations)
		.where(inArray(conversations.userId, createdUserIds));
	await db.delete(users).where(inArray(users.id, createdUserIds));
});

/**
 * A user, a conversation and a document written at T0 by the turn that ended with
 * a refresh while the document was fresh. The clock is then moved `ageMs` on, so
 * the person comes back to a document written that long ago.
 */
async function worldWithDocumentWrittenAgo(ageMs: number) {
	worlds += 1;
	const userId = randomUUID();
	createdUserIds.push(userId);
	await db.insert(users).values({
		id: userId,
		email: `working-set-carryover-${userId}@example.com`,
		passwordHash: "hash",
		name: "Working Set Carryover",
		role: "user",
	});
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(T0);
	const conversation = await createConversation(userId, "Lease review");
	const marker = `ZANZIBAR-CLAUSE-${worlds}`;
	const document = await createArtifact({
		userId,
		conversationId: conversation.id,
		type: "generated_output",
		name: "Lease review.md",
		mimeType: "text/markdown",
		extension: "md",
		contentText: `Lease review. The tenant deposit refund clause (${marker}) says the landlord returns the deposit within thirty days.`,
		summary: "Lease review: the deposit refund clause",
	});
	vi.setSystemTime(T0 + 5_000);
	await refreshConversationWorkingSet({
		userId,
		conversationId: conversation.id,
		message: "Write a lease review",
		selectedGeneratedArtifactId: document.id,
	});
	vi.setSystemTime(T0 + Math.max(ageMs, 5_000));
	return { userId, conversationId: conversation.id, document, marker };
}

/**
 * One turn with the document open in the workspace: the prompt is built, then the
 * turn ends the way `persistAssistantTurnState` ends it for the working set (the
 * reply stored as a generated output, the working set refreshed with the message
 * and the open document). Returns whether the document's text is in the prompt.
 */
async function turn(
	world: Awaited<ReturnType<typeof worldWithDocumentWrittenAgo>>,
	message: string,
): Promise<boolean> {
	const { userId, conversationId, document, marker } = world;
	const context = await buildConstructedContext({
		userId,
		conversationId,
		message,
		activeDocumentArtifactId: document.id,
	});
	const reply = await createGeneratedOutputArtifact({
		userId,
		conversationId,
		messageId: randomUUID(),
		content: "Here is my answer.",
		sourceArtifactIds: [],
	});
	await refreshConversationWorkingSet({
		userId,
		conversationId,
		message,
		activeDocumentArtifactId: document.id,
		selectedGeneratedArtifactId: reply?.id ?? null,
	});
	vi.setSystemTime(Date.now() + 30_000);
	return context.inputValue.includes(marker);
}

async function workingSetRow(conversationId: string, artifactId: string) {
	const rows = await db
		.select()
		.from(conversationWorkingSetItems)
		.where(eq(conversationWorkingSetItems.conversationId, conversationId));
	return rows.find((row) => row.artifactId === artifactId) ?? null;
}

describe("a long chat", () => {
	it("does not pile its own old replies into the working set or the prompt", async () => {
		// Every reply is stored as a generated output and is, for a turn, the
		// current generated document. Each also shares a few words with the next
		// question, and a match with the message is the weakest reason to keep a
		// document: it must not keep the chat's old replies once the chat has moved
		// on. (Without the age on that one term: 16 active, 18 of 20 replies in the
		// prompt, 2.9 kB of replies the history already holds.)
		const world = await worldWithDocumentWrittenAgo(0);
		const { userId, conversationId } = world;
		const topics = [
			"the parking space",
			"pets in the apartment",
			"the heating",
			"the broken boiler",
			"subletting",
			"painting the walls",
			"the insurance",
			"the internet contract",
			"the inventory list",
			"the landlord's visits",
			"the rent increase",
			"the notice period",
		];
		for (const [index, topic] of topics.entries()) {
			vi.setSystemTime(T0 + (index + 1) * 3 * MINUTE);
			const reply = await createArtifact({
				userId,
				conversationId,
				type: "generated_output",
				name: `Lease chat result ${index + 1}`,
				mimeType: "text/markdown",
				extension: "md",
				contentText: `The landlord and the tenant agree in the lease how ${topic} is handled, and the contract says what to do. (REPLY-${index + 1})`,
				summary: `How ${topic} is handled in the lease`,
			});
			await refreshConversationWorkingSet({
				userId,
				conversationId,
				message: `Does the lease say what happens with ${topic}?`,
				selectedGeneratedArtifactId: reply.id,
			});
		}
		vi.setSystemTime(T0 + (topics.length + 1) * 3 * MINUTE);

		const rows = await db
			.select()
			.from(conversationWorkingSetItems)
			.where(eq(conversationWorkingSetItems.conversationId, conversationId));
		const context = await buildConstructedContext({
			userId,
			conversationId,
			message: "And what should I write to the landlord about the contract?",
			activeDocumentArtifactId: world.document.id,
		});
		const repliesInPrompt = topics.filter((_, index) =>
			context.inputValue.includes(`REPLY-${index + 1}`),
		).length;

		expect(
			rows.filter((row) => row.state === "active").length,
		).toBeLessThanOrEqual(2);
		expect(repliesInPrompt).toBeLessThanOrEqual(2);
	});
});

describe.each([
	["ten minutes", 10 * MINUTE],
	["an hour", HOUR],
	["a day", DAY],
])("a document last written %s ago, open in the workspace", (_label, ageMs) => {
	it("stays active in the working set after a turn that named it, and the next turn selects it", async () => {
		const world = await worldWithDocumentWrittenAgo(ageMs);
		const { userId, conversationId, document } = world;

		await turn(world, "Please make this document shorter");

		const row = await workingSetRow(conversationId, document.id);
		expect(row?.state).toBe("active");
		expect(row?.reasonCodesJson).toContain("active_document_focus");
		const selected = await selectWorkingSetArtifactsForPrompt(
			userId,
			conversationId,
			"And what about the second paragraph?",
			[],
			document.id,
		);
		expect(selected.map((artifact) => artifact.id)).toEqual([document.id]);
	});

	it("is in the next turn's prompt although that turn's message does not name it", async () => {
		const world = await worldWithDocumentWrittenAgo(ageMs);

		const namedInPrompt = await turn(
			world,
			"Please make this document shorter",
		);
		const followUpInPrompt = await turn(
			world,
			"And what about the second paragraph?",
		);

		expect(namedInPrompt).toBe(true);
		expect(followUpInPrompt).toBe(true);
	});

	it("is let go once the conversation moves on to something else", async () => {
		// What the age must not become: a reason to keep a document. The turn
		// after the one that named it still carries it; a turn about something
		// else ends without anything pointing at it, and the one after that
		// does not.
		const world = await worldWithDocumentWrittenAgo(ageMs);

		await turn(world, "Please make this document shorter");
		const carried = await turn(world, "What is the capital of Hungary?");
		const letGo = await turn(world, "And what is the capital of Austria?");

		expect(carried).toBe(true);
		expect(letGo).toBe(false);
	});
});
