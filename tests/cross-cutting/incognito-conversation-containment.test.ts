// The other half of the incognito promise: the CONVERSATION itself.
//
// The composer says "Incognito · nothing here is remembered", and the privacy
// policy calls the mode "saved-but-untracked" — the chat is kept so the user
// can revisit it, and it is "never tracked or used to personalize future
// replies". `memory-controls.ts` states it as a rule: an incognito conversation
// "is never fed to the memory pipeline".
//
// It was enforced on the WRITE side only. The memory judge refuses to learn
// from an incognito turn, and that was taken to be the whole boundary — but
// `memory_context` in `history` mode searches the user's conversations
// directly, not the memory it learned from them. From an ordinary chat it
// returned a candidate quoting the raw user message of an incognito one,
// secret and all. The project-folder side had the same shape: a folder
// sibling's title, summary and whole recent dialogue are injected into its
// siblings' prompts, incognito or not.
//
// The boundary is now enforced in ONE place —
// `buildConversationContextScopeCondition` (`services/conversation-scope.ts`),
// the conversation-side twin of `getArtifactOwnershipScope` — so this file has
// two halves, exactly like the artifact one:
//
//   PART A, behaviour: type a canary into an incognito conversation, then try
//   to reach it from a normal one through every context read that exists. And
//   the directions that must keep working: the conversation's own reads,
//   turning the flag off, and deletion.
//
//   PART B, a guard: every file in `src/lib/server` that reads `conversations`
//   / `messages` / `conversation_summaries` across conversations for a user
//   goes through that condition, or is named here with the reason it does not.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative as relativePath } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

vi.mock("$lib/server/services/tei-reranker", () => ({
	canUseTeiReranker: vi.fn(() => false),
	rerankItems: vi.fn(),
}));

vi.mock("$lib/server/services/tei-embedder", () => ({
	canUseTeiEmbedder: vi.fn(() => false),
	embedTexts: vi.fn(),
	embedText: vi.fn(),
}));

vi.mock("$lib/server/services/task-state/control-model", () => ({
	canUseContextSummarizer: vi.fn(() => false),
	requestContextSummarizer: vi.fn(),
}));

const { getMemoryContext } = await import(
	"$lib/server/services/memory-context"
);
const {
	findProjectFolderReferenceContextByQuery,
	getProjectFolderReferenceContext,
	getProjectReferenceContext,
	selectProjectFolderSiblingPromotion,
} = await import("$lib/server/services/task-state/continuity");
const { getConversationSummary } = await import(
	"$lib/server/services/conversation-summaries"
);
const { listMessages } = await import("$lib/server/services/messages");
const { deleteConversationWithCleanup } = await import(
	"$lib/server/services/cleanup/conversation-cleanup"
);
const { recordMemoryBehaviorEvent } = await import(
	"$lib/server/services/memory-behavior-log"
);

const USER = "user-1";
const INCOGNITO = "conv-incognito";
const NORMAL = "conv-normal";
const PROJECT = "project-1";
const PROJECT_INCOGNITO = "conv-project-incognito";
const PROJECT_NORMAL = "conv-project-normal";
const NOW = new Date("2026-09-20T10:00:00.000Z");

/** Words that exist ONLY inside an incognito conversation. */
const USER_CANARY = "zalophus";
const ASSISTANT_CANARY = "pinniped";
const SUMMARY_CANARY = "otariid";
const TITLE_CANARY = "monachus";

function seedUser(id: string) {
	memory.db
		.insert(schema.users)
		.values({
			id,
			email: `${id}@example.com`,
			passwordHash: "hash",
			memoryEnabled: true,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

function seedConversation(params: {
	id: string;
	memoryIncognito: boolean;
	projectId?: string | null;
	title?: string;
}) {
	memory.db
		.insert(schema.conversations)
		.values({
			id: params.id,
			userId: USER,
			title: params.title ?? params.id,
			projectId: params.projectId ?? null,
			memoryIncognito: params.memoryIncognito,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

function seedDialogue(conversationId: string, userText: string, reply: string) {
	memory.db
		.insert(schema.messages)
		.values([
			{
				id: `${conversationId}-user`,
				conversationId,
				messageSequence: 1,
				role: "user",
				content: userText,
				createdAt: NOW,
			},
			{
				id: `${conversationId}-assistant`,
				conversationId,
				messageSequence: 2,
				role: "assistant",
				content: reply,
				createdAt: NOW,
			},
		])
		.run();
}

function seedSummary(conversationId: string, summary: string) {
	memory.db
		.insert(schema.conversationSummaries)
		.values({
			conversationId,
			userId: USER,
			summary,
			source: "deterministic",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

/** What an incognito conversation leaves behind: its turns and its summary. */
function seedIncognitoWork() {
	seedDialogue(
		INCOGNITO,
		`My severance password is ${USER_CANARY}, do not remember it.`,
		`Understood, the ${ASSISTANT_CANARY} clause stays here.`,
	);
	seedSummary(INCOGNITO, `A ${SUMMARY_CANARY} severance negotiation.`);
}

function setIncognito(conversationId: string, value: boolean) {
	memory.db
		.update(schema.conversations)
		.set({ memoryIncognito: value })
		.where(eq(schema.conversations.id, conversationId))
		.run();
}

/**
 * Every canary, in one place: a payload may contain none of them.
 *
 * The `query` and the `audit` block are dropped first: both echo the caller's
 * own query back for the model's benefit, and in these tests that query IS the
 * canary. A caller's own words coming back are not a disclosure of anything.
 */
function expectNoCanary(payload: unknown) {
	const {
		audit: _audit,
		query: _query,
		...rest
	} = (payload ?? {}) as Record<string, unknown>;
	const serialised = JSON.stringify(rest);
	for (const canary of [
		USER_CANARY,
		ASSISTANT_CANARY,
		SUMMARY_CANARY,
		TITLE_CANARY,
	]) {
		expect(serialised).not.toContain(canary);
	}
}

beforeEach(() => {
	memory = createInMemoryDatabase();
	seedUser(USER);
	seedConversation({ id: INCOGNITO, memoryIncognito: true });
	seedConversation({ id: NORMAL, memoryIncognito: false });
	memory.db
		.insert(schema.projects)
		.values({
			id: PROJECT,
			userId: USER,
			name: "Severance folder",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	seedConversation({
		id: PROJECT_INCOGNITO,
		memoryIncognito: true,
		projectId: PROJECT,
		title: `The ${TITLE_CANARY} negotiation`,
	});
	seedConversation({
		id: PROJECT_NORMAL,
		memoryIncognito: false,
		projectId: PROJECT,
		title: "Ordinary planning",
	});
});

afterEach(() => {
	memory.close();
});

describe("an incognito conversation, from a NORMAL conversation", () => {
	beforeEach(() => {
		seedIncognitoWork();
	});

	it("is not found by memory_context in history mode", async () => {
		const result = await getMemoryContext({
			userId: USER,
			conversationId: NORMAL,
			mode: "history",
			query: `${USER_CANARY} severance password`,
		});

		expectNoCanary(result);
		expect(JSON.stringify(result)).not.toContain(INCOGNITO);
	});

	it("is not found by a history search for its summary either", async () => {
		// A conversation that SHOULD be found, carrying the same word, so a miss
		// proves exclusion rather than a search that finds nothing at all.
		seedSummary(NORMAL, "An ordinary severance question.");
		seedConversation({ id: "conv-third", memoryIncognito: false });
		seedSummary("conv-third", `An ordinary ${SUMMARY_CANARY} note.`);

		const result = await getMemoryContext({
			userId: USER,
			conversationId: NORMAL,
			mode: "history",
			query: `${SUMMARY_CANARY} severance`,
		});

		expect(
			result.mode === "history"
				? result.conversations.map((row) => row.conversationId)
				: [],
		).toEqual(["conv-third"]);
		expect(JSON.stringify(result)).not.toContain(INCOGNITO);
	});

	it("cannot be opened by id, even by a caller that names it", async () => {
		await expect(
			getMemoryContext({
				userId: USER,
				conversationId: NORMAL,
				mode: "history",
				query: `${USER_CANARY} severance`,
				historyConversationId: INCOGNITO,
			}),
		).rejects.toThrow(/outside memory_context history scope/);
	});

	it("is not in the persona or project modes of the tool", async () => {
		for (const mode of ["persona", "project"]) {
			const result = await getMemoryContext({
				userId: USER,
				conversationId: NORMAL,
				mode,
				query: `${USER_CANARY} ${SUMMARY_CANARY} severance`,
			});
			expectNoCanary(result);
		}
	});
});

describe("an incognito sibling of a project folder", () => {
	beforeEach(() => {
		seedDialogue(
			PROJECT_INCOGNITO,
			`The ${USER_CANARY} number is in the offer.`,
			`Noted, ${ASSISTANT_CANARY}.`,
		);
		seedSummary(PROJECT_INCOGNITO, `The ${SUMMARY_CANARY} offer.`);
	});

	it("is not listed to its siblings, and is not counted", async () => {
		const reference = await getProjectFolderReferenceContext({
			userId: USER,
			conversationId: PROJECT_NORMAL,
		});

		// The only sibling is incognito, so there is no folder context at all
		// rather than one with an omitted-count hinting at what is missing.
		expect(reference).toBeNull();
	});

	it("is not listed by the folder lookup a query resolves to", async () => {
		const reference = await findProjectFolderReferenceContextByQuery({
			userId: USER,
			conversationId: PROJECT_NORMAL,
			query: "severance folder",
		});

		expectNoCanary(reference);
		expect(
			reference?.entries.map((entry) => entry.conversationId) ?? [],
		).toEqual([PROJECT_NORMAL]);
	});

	it("is never promoted, so its dialogue never reaches another prompt", async () => {
		// The promotion ranks siblings by TITLE, objective and summary, and this
		// query hits the incognito sibling's title twice — comfortably over the
		// score and matched-term floors. Without the scope it wins and its whole
		// recent dialogue is read into the asking conversation's prompt.
		const promotion = await selectProjectFolderSiblingPromotion({
			userId: USER,
			conversationId: PROJECT_NORMAL,
			query: `${TITLE_CANARY} negotiation`,
		});

		expect(promotion).toBeNull();

		// The same mechanism, live: from inside the incognito conversation an
		// ORDINARY sibling is still promoted, so the null above is an exclusion
		// and not a ranking that never fires.
		seedDialogue(
			PROJECT_NORMAL,
			"Ordinary planning for the launch.",
			"Here is the ordinary plan.",
		);
		const control = await selectProjectFolderSiblingPromotion({
			userId: USER,
			conversationId: PROJECT_INCOGNITO,
			query: "ordinary planning",
		});
		expect(control?.conversationId).toBe(PROJECT_NORMAL);
	});

	it("is not in memory_context project mode from a sibling", async () => {
		const result = await getMemoryContext({
			userId: USER,
			conversationId: PROJECT_NORMAL,
			mode: "project",
			query: `${USER_CANARY} ${SUMMARY_CANARY} offer`,
		});

		expectNoCanary(result);
		expect(JSON.stringify(result)).not.toContain(PROJECT_INCOGNITO);
	});

	it("writes no memory event a later turn could count", async () => {
		await recordMemoryBehaviorEvent({
			eventKey: "document_refined:family-1",
			userId: USER,
			conversationId: PROJECT_INCOGNITO,
			domain: "document",
			eventType: "document_refined",
			subjectId: "family-1",
		});
		await recordMemoryBehaviorEvent({
			eventKey: "document_refined:family-2",
			userId: USER,
			conversationId: PROJECT_NORMAL,
			domain: "document",
			eventType: "document_refined",
			subjectId: "family-2",
		});

		const subjects = memory.db
			.select({ subjectId: schema.memoryEvents.subjectId })
			.from(schema.memoryEvents)
			.all()
			.map((row) => row.subjectId);
		expect(subjects).toEqual(["family-2"]);
	});
});

describe("inside the incognito conversation, everything still works", () => {
	beforeEach(() => {
		seedIncognitoWork();
	});

	it("reads its own turns and its own summary", async () => {
		const own = await listMessages(INCOGNITO);
		expect(JSON.stringify(own)).toContain(USER_CANARY);
		expect(JSON.stringify(own)).toContain(ASSISTANT_CANARY);

		const summary = await getConversationSummary({
			userId: USER,
			conversationId: INCOGNITO,
		});
		expect(summary?.summary).toContain(SUMMARY_CANARY);
	});

	it("still sees itself in its own project folder", async () => {
		const reference = await findProjectFolderReferenceContextByQuery({
			userId: USER,
			conversationId: PROJECT_INCOGNITO,
			query: "severance folder",
		});

		expect(
			reference?.entries.map((entry) => entry.conversationId) ?? [],
		).toContain(PROJECT_INCOGNITO);
	});

	it("still reads its folder's ordinary siblings", async () => {
		seedSummary(PROJECT_NORMAL, "An ordinary planning summary.");

		const reference = await getProjectReferenceContext({
			userId: USER,
			conversationId: PROJECT_INCOGNITO,
		});

		expect(
			reference?.entries.map((entry) => entry.conversationId) ?? [],
		).toEqual([PROJECT_NORMAL]);
	});
});

describe("turning incognito off", () => {
	it("exposes the conversation, exactly as it re-admits its files", async () => {
		seedIncognitoWork();

		setIncognito(INCOGNITO, false);

		const result = await getMemoryContext({
			userId: USER,
			conversationId: NORMAL,
			mode: "history",
			query: `${USER_CANARY} severance password`,
		});

		expect(JSON.stringify(result)).toContain(USER_CANARY);
	});
});

describe("deleting an incognito conversation", () => {
	it("takes its turns and its summary with it", async () => {
		seedIncognitoWork();

		await deleteConversationWithCleanup(USER, INCOGNITO);

		const remainingMessages = memory.db
			.select({ id: schema.messages.id })
			.from(schema.messages)
			.where(eq(schema.messages.conversationId, INCOGNITO))
			.all();
		expect(remainingMessages).toEqual([]);

		const remainingSummaries = memory.db
			.select({ conversationId: schema.conversationSummaries.conversationId })
			.from(schema.conversationSummaries)
			.where(eq(schema.conversationSummaries.conversationId, INCOGNITO))
			.all();
		expect(remainingSummaries).toEqual([]);
	});
});

// The instruction offer is a learning-shaped surface (Slice F): it exists to
// turn something the user said into an instruction AlfyAI keeps. Incognito's
// promise is that nothing is learned from the conversation, so the offer is
// withheld there — while the instructions themselves keep applying and
// `/instruction` keeps working, because a standing instruction is not a memory
// OF the conversation. The gate is the tool catalogue, resolved once per
// conversation from this same flag, which is also what keeps the prompt
// prefix (and its cache) stable across a conversation's turns.
describe("the instruction offer", () => {
	it("never registers the instruction-suggestion tool in an incognito conversation", async () => {
		const normal = await buildTurnToolPack(NORMAL);
		const incognito = await buildTurnToolPack(INCOGNITO);

		// The control matters: the same call does carry the tool for an
		// ordinary conversation, so its absence below is this flag and not a
		// tool that is never registered for anyone.
		expect(normal.tools?.suggest_instruction).toBeDefined();
		expect(incognito.tools?.suggest_instruction).toBeUndefined();
	});

	it("never writes an instruction suggestion into an incognito conversation", async () => {
		// The tool call is the only writer, and what it writes is the recorded
		// offer `finalizeChatTurn` lifts onto the assistant message. So the
		// assertion is on that one route: in an ordinary conversation the same
		// call records a pending offer (the control), and in an incognito
		// conversation there is no tool to call at all.
		const normalEntries = await callSuggestInstruction(NORMAL);
		expect(normalEntries).toHaveLength(1);
		expect(normalEntries?.[0]?.instructionSuggestion).toMatchObject({
			status: "pending",
			text: OFFER_TEXT,
		});

		seedDialogue(
			INCOGNITO,
			`From now on, ${USER_CANARY} only. Do not remember this.`,
			"Understood.",
		);
		const incognitoEntries = await callSuggestInstruction(INCOGNITO);
		// `null` is "there was no tool to call", not "the call was refused": a
		// refusal records an explicit `null` suggestion on a recorded call.
		expect(incognitoEntries).toBeNull();

		// And the conversation's own rows carry no offer: nothing but that
		// recorded entry ever reaches a message's metadata.
		const messages = await listMessages(INCOGNITO);
		expect(JSON.stringify(messages)).not.toContain(OFFER_TEXT);
	});
});

const OFFER_TEXT = "Only suggest trains, never flights.";

/** The pack a turn is handed, built the way a turn builds it. */
async function buildTurnToolPack(conversationId: string) {
	const { createToolPack } = await import(
		"$lib/server/services/chat-turn/shared-normal-chat-model-run-helpers"
	);
	const { getConfig } = await import("$lib/server/config-store");
	return createToolPack(
		{
			userId: USER,
			conversationId,
			message: OFFER_TEXT,
			modelId: "model1",
			runtimeConfig: getConfig(),
		},
		"turn-instruction-offer",
		null,
		"model1",
		new Set(),
	);
}

/**
 * Runs the conversation's real `suggest_instruction` tool once, and answers
 * with the turn's recorded tool calls — the whole of what finalize can turn
 * into an offer — or `null` when this conversation's pack has no such tool.
 */
async function callSuggestInstruction(conversationId: string) {
	const pack = await buildTurnToolPack(conversationId);
	const tool = pack.tools?.suggest_instruction as
		| { execute?: (input: unknown, options: unknown) => Promise<unknown> }
		| undefined;
	if (!tool?.execute) return null;
	await tool.execute(
		{ text: OFFER_TEXT, scope: "personal" },
		{ toolCallId: `call-${conversationId}`, messages: [] },
	);
	return pack.getToolCalls();
}

// ── PART B: the guard ──────────────────────────────────────────
//
// `buildConversationContextScopeCondition` is the boundary. A query that reads
// `conversations`, `messages` or `conversation_summaries` for a USER without
// going through it — and without pinning itself to one conversation, which is
// the same boundary spelled directly — is a new way out of an incognito chat,
// and the point of this guard is that it fails on the day it is written rather
// than in a live check months later.

const SERVER_ROOT = join(process.cwd(), "src", "lib", "server");

/**
 * Any of these in a file means it has thought about the boundary.
 *
 * Deliberately NOT "this query happens to be pinned to one conversation". The
 * artifact guard accepts that as a marker because an artifact query pins with
 * a column the boundary itself is about; here a pin is one `ne(...)` away from
 * a sweep, and the files that pin are also the files that hold the sidebar
 * listing and the export. Naming each of them below costs a line and makes the
 * decision visible, which is the point of the guard.
 */
const SCOPE_MARKERS = [
	"buildConversationContextScopeCondition",
	"ConversationContextScopeOptions",
	// A file that reads the flag itself has made the decision explicitly —
	// `analytics.ts` and `user-admin.ts` exclude incognito conversations from
	// their counts with their own `memory_incognito = false` term.
	"memoryIncognito",
	"isMemoryActiveForConversation",
	"isConversationIncognito",
];

/**
 * Files that read these tables across conversations and go through none of the
 * above, each with the reason it is allowed to. Every entry is a UI listing the
 * user reads themselves, an administrative sweep that must see every row the
 * user owns, or a read whose ids came from a query that IS scoped. Adding a
 * line here is a decision about the incognito promise; make it deliberately.
 */
const ALLOWED_WITHOUT_SCOPE: Record<string, string> = {
	// UI listings: incognito hides a chat from the ASSISTANT, not from the
	// person who had it. The sidebar even marks it with a badge, and none of
	// these three is on a model path — they answer `/api/workspace-search` and
	// `/api/home/summary` and nothing else.
	"services/workspace-search.ts":
		"the user's own search over their own chats; its ARTIFACT halves are scoped, its conversation halves are a listing",
	"services/home-summary.ts":
		"the home screen's weekly bars and recent list, rendered for the user, never fed to a model",
	"services/home-suggestions.ts":
		"home-screen chips built deterministically from recent titles; no model call anywhere in that module",
	// Administration: deletion, export, erasure and orphan sweeps must see
	// every row the user owns, or an incognito conversation would become
	// undeletable — the same exception the artifact scope makes.
	"services/account-data-archive/index.ts":
		"the user's own data export — incognito conversations are saved to the account and are exported with it",
	"services/cleanup/conversation-cleanup.ts":
		"deletion of one conversation and everything hanging off it",
	"services/memory-maintenance.ts":
		"orphan pruning over the user's own rows; it deletes, it never returns text to a prompt",
	"services/projects.ts":
		"project membership writes and the project delete path",
	"services/messages.ts":
		"the conversation's own message reads, plus evidence erasure across the account",
	"services/chat-files.ts":
		"the chat-file delete and orphan sweep; its cross-conversation READS go through `getArtifactOwnershipScope`",
	// Reads pinned to the conversation being served, which is this same
	// boundary spelled directly.
	"services/conversation-summaries.ts":
		"one conversation's own summary, by (userId, conversationId)",
	"services/knowledge/capsules.ts": "the work capsule of one conversation",
	"services/conversations.ts":
		"the sidebar listing and the conversation's own page; it is also where the incognito flag is toggled",
};

function listSourceFiles(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			found.push(...listSourceFiles(full));
		} else if (entry.name.endsWith(".ts") && !entry.name.includes(".test")) {
			found.push(relativePath(SERVER_ROOT, full));
		}
	}
	return found;
}

describe("every cross-conversation context read goes through the scope", () => {
	it("has no unscoped reader of conversations, messages or summaries", () => {
		const offenders: string[] = [];
		for (const relative of listSourceFiles(SERVER_ROOT).sort()) {
			const source = readFileSync(join(SERVER_ROOT, relative), "utf8");
			const readsTables =
				source.includes(".from(conversations)") ||
				source.includes(".from(messages)") ||
				source.includes(".from(conversationSummaries)");
			if (!readsTables) continue;
			// Only a query that selects by USER can cross a conversation
			// boundary; one that does not is already narrower than this rule.
			const isUserScoped =
				source.includes("conversations.userId") ||
				source.includes("conversationSummaries.userId");
			if (!isUserScoped) continue;
			if (SCOPE_MARKERS.some((marker) => source.includes(marker))) continue;
			const key = relative.replace(/\\/g, "/");
			if (key in ALLOWED_WITHOUT_SCOPE) continue;
			offenders.push(key);
		}

		expect(
			offenders,
			[
				"These files read conversations / messages / conversation_summaries by",
				"user without going through buildConversationContextScopeCondition (or",
				"pinning the query to one conversation). Either scope the query, or add",
				"the file to ALLOWED_WITHOUT_SCOPE with the reason it is safe:",
				offenders.join("\n  "),
			].join("\n"),
		).toEqual([]);
	});

	it("keeps the allow-list honest", () => {
		// An entry that no longer matches a real file is a stale exemption, and
		// a stale exemption is how the next unscoped query gets in unnoticed.
		for (const relative of Object.keys(ALLOWED_WITHOUT_SCOPE)) {
			expect(() =>
				readFileSync(join(SERVER_ROOT, relative), "utf8"),
			).not.toThrow();
		}
	});
});
