// Atlas Local Sources against a real (in-memory) database: which of the user's
// documents an Atlas job may read, resolved only through the knowledge
// boundary and only under the job conversation's strict incognito scope.
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

const {
	fitAtlasV3LocalPassages,
	resolveAtlasV3LocalSources,
	selectAtlasV3LocalPassages,
} = await import("./local-sources");

const USER = "user-1";
const OTHER_USER = "user-2";
const JOB_CONVERSATION = "conv-atlas";
const EARLIER_CONVERSATION = "conv-earlier";
const KICKOFF = "msg-kickoff";
const NOW = new Date("2026-09-20T10:00:00.000Z");

function seedUser(id: string) {
	memory.db
		.insert(schema.users)
		.values({
			id,
			email: `${id}@example.com`,
			passwordHash: "hash",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

function seedConversation(id: string, userId: string, memoryIncognito = false) {
	memory.db
		.insert(schema.conversations)
		.values({
			id,
			userId,
			title: id,
			memoryIncognito,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

function seedMessage(id: string, conversationId: string) {
	memory.db
		.insert(schema.messages)
		.values({
			id,
			conversationId,
			role: "user",
			content: "Compare our electricity use with the national average.",
			createdAt: NOW,
		})
		.run();
}

function seedArtifact(params: {
	userId: string;
	conversationId: string | null;
	type: "normalized_document" | "source_document";
	name: string;
	chunks: string[];
}): string {
	const id = `artifact-${params.type}-${params.name}-${params.conversationId}`;
	const contentText = params.chunks.join("\n\n");
	memory.db
		.insert(schema.artifacts)
		.values({
			id,
			userId: params.userId,
			conversationId: params.conversationId,
			type: params.type,
			retrievalClass: "durable",
			name: params.name,
			mimeType: "text/markdown",
			extension: "md",
			sizeBytes: contentText.length,
			contentText,
			summary: contentText.slice(0, 240),
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	params.chunks.forEach((chunk, chunkIndex) => {
		memory.db
			.insert(schema.artifactChunks)
			.values({
				id: `${id}:${chunkIndex}`,
				artifactId: id,
				userId: params.userId,
				conversationId: params.conversationId,
				chunkIndex,
				contentText: chunk,
				tokenEstimate: Math.ceil(chunk.length / 4),
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
	});
	return id;
}

/** An upload as ingestion leaves it: source + normalized text, linked. */
function seedUpload(params: {
	userId?: string;
	conversationId: string;
	name: string;
	chunks: string[];
}) {
	const userId = params.userId ?? USER;
	const sourceId = seedArtifact({
		userId,
		conversationId: params.conversationId,
		type: "source_document",
		name: params.name,
		chunks: params.chunks,
	});
	const normalizedId = seedArtifact({
		userId,
		conversationId: params.conversationId,
		type: "normalized_document",
		name: `${params.name.replace(/\.[^.]+$/, "")}.md`,
		chunks: params.chunks,
	});
	memory.db
		.insert(schema.artifactLinks)
		.values({
			id: `link-derived-${normalizedId}`,
			userId,
			artifactId: normalizedId,
			relatedArtifactId: sourceId,
			conversationId: params.conversationId,
			linkType: "derived_from",
			createdAt: NOW,
		})
		.run();
	return { sourceId, normalizedId };
}

function linkToKickoff(params: {
	artifactId: string;
	relatedArtifactId?: string | null;
	linkType: "attached_to_conversation" | "linked_context_source";
	messageId?: string | null;
}) {
	memory.db
		.insert(schema.artifactLinks)
		.values({
			id: `link-${params.linkType}-${params.artifactId}-${params.messageId ?? "none"}`,
			userId: USER,
			artifactId: params.artifactId,
			relatedArtifactId: params.relatedArtifactId ?? null,
			conversationId: JOB_CONVERSATION,
			messageId: params.messageId === undefined ? KICKOFF : params.messageId,
			linkType: params.linkType,
			createdAt: NOW,
		})
		.run();
}

const BILL = [
	"Electricity bill 2025. Our household used 1,234 kWh of electricity in 2025 according to the meter log.",
	"The tariff rose to 45 cents per kWh in January, and the standing charge doubled.",
];

beforeEach(() => {
	memory = createInMemoryDatabase();
	seedUser(USER);
	seedUser(OTHER_USER);
	seedConversation(JOB_CONVERSATION, USER);
	seedConversation(EARLIER_CONVERSATION, USER);
	seedMessage(KICKOFF, JOB_CONVERSATION);
});

afterEach(() => {
	memory.close();
});

describe("resolveAtlasV3LocalSources", () => {
	it("resolves a kickoff attachment through its normalized document", async () => {
		const { sourceId, normalizedId } = seedUpload({
			conversationId: JOB_CONVERSATION,
			name: "bill.pdf",
			chunks: BILL,
		});
		linkToKickoff({
			artifactId: sourceId,
			linkType: "attached_to_conversation",
		});

		const resolved = await resolveAtlasV3LocalSources({
			userId: USER,
			conversationId: JOB_CONVERSATION,
			kickoffUserMessageId: KICKOFF,
		});
		expect(resolved.unavailable).toEqual([]);
		expect(resolved.documents).toEqual([
			expect.objectContaining({
				displayArtifactId: sourceId,
				promptArtifactId: normalizedId,
				title: "bill.pdf",
				origin: "attachment",
			}),
		]);
	});

	it("keeps the job conversation's own documents when it is itself incognito", async () => {
		memory.db.update(schema.conversations).set({ memoryIncognito: true }).run();
		const { sourceId } = seedUpload({
			conversationId: JOB_CONVERSATION,
			name: "bill.pdf",
			chunks: BILL,
		});
		linkToKickoff({
			artifactId: sourceId,
			linkType: "attached_to_conversation",
		});

		const resolved = await resolveAtlasV3LocalSources({
			userId: USER,
			conversationId: JOB_CONVERSATION,
			kickoffUserMessageId: KICKOFF,
		});
		expect(resolved.documents).toHaveLength(1);
		expect(resolved.unavailable).toEqual([]);
	});

	it("resolves a snapshotted linked source and ignores conversation-level links", async () => {
		const { sourceId, normalizedId } = seedUpload({
			conversationId: EARLIER_CONVERSATION,
			name: "survey.pdf",
			chunks: BILL,
		});
		linkToKickoff({
			artifactId: sourceId,
			relatedArtifactId: normalizedId,
			linkType: "linked_context_source",
		});
		// The conversation-level row (no message) is the chat's standing link,
		// not this kickoff's snapshot.
		const other = seedUpload({
			conversationId: EARLIER_CONVERSATION,
			name: "unrelated.pdf",
			chunks: ["Something else entirely, with no bearing on anything."],
		});
		linkToKickoff({
			artifactId: other.sourceId,
			relatedArtifactId: other.normalizedId,
			linkType: "linked_context_source",
			messageId: null,
		});

		const resolved = await resolveAtlasV3LocalSources({
			userId: USER,
			conversationId: JOB_CONVERSATION,
			kickoffUserMessageId: KICKOFF,
		});
		expect(resolved.documents).toEqual([
			expect.objectContaining({
				displayArtifactId: sourceId,
				promptArtifactId: normalizedId,
				origin: "linked",
			}),
		]);
	});

	it("refuses a linked source whose conversation has since gone incognito", async () => {
		const { sourceId, normalizedId } = seedUpload({
			conversationId: EARLIER_CONVERSATION,
			name: "severance.pdf",
			chunks: BILL,
		});
		linkToKickoff({
			artifactId: sourceId,
			relatedArtifactId: normalizedId,
			linkType: "linked_context_source",
		});
		memory.db
			.update(schema.conversations)
			.set({ memoryIncognito: true })
			// Only the EARLIER conversation turns incognito.
			.where(eq(schema.conversations.id, EARLIER_CONVERSATION))
			.run();

		const resolved = await resolveAtlasV3LocalSources({
			userId: USER,
			conversationId: JOB_CONVERSATION,
			kickoffUserMessageId: KICKOFF,
		});
		expect(resolved.documents).toEqual([]);
		expect(resolved.unavailable).toEqual([
			{
				displayArtifactId: sourceId,
				title: "severance.pdf",
				origin: "linked",
				reason: "out_of_scope",
			},
		]);
	});

	it("reports another user's artifact as not found", async () => {
		seedConversation("conv-other-user", OTHER_USER);
		const { sourceId, normalizedId } = seedUpload({
			userId: OTHER_USER,
			conversationId: "conv-other-user",
			name: "theirs.pdf",
			chunks: BILL,
		});
		linkToKickoff({
			artifactId: sourceId,
			relatedArtifactId: normalizedId,
			linkType: "linked_context_source",
		});
		linkToKickoff({
			artifactId: sourceId,
			linkType: "attached_to_conversation",
		});

		const resolved = await resolveAtlasV3LocalSources({
			userId: USER,
			conversationId: JOB_CONVERSATION,
			kickoffUserMessageId: KICKOFF,
		});
		expect(resolved.documents).toEqual([]);
		expect(resolved.unavailable.map((entry) => entry.reason)).toEqual([
			"not_found",
			"not_found",
		]);
		expect(resolved.unavailable.every((entry) => entry.title === null)).toBe(
			true,
		);
	});

	// A lifecycle child inherits its parent's documents by display id alone.
	// Those ids are re-resolved under THIS job's strict scope: a document whose
	// chat went incognito since the parent read it, one deleted since, and one
	// that was never this user's all stay out.
	it("re-resolves inherited documents under the job's scope, refusing incognito, deleted and foreign ones", async () => {
		const kept = seedUpload({
			conversationId: EARLIER_CONVERSATION,
			name: "kept.pdf",
			chunks: BILL,
		});
		seedConversation("conv-private", USER);
		const privateNow = seedUpload({
			conversationId: "conv-private",
			name: "private.pdf",
			chunks: BILL,
		});
		seedConversation("conv-other-user", OTHER_USER);
		const foreign = seedUpload({
			userId: OTHER_USER,
			conversationId: "conv-other-user",
			name: "theirs.pdf",
			chunks: BILL,
		});
		memory.db
			.update(schema.conversations)
			.set({ memoryIncognito: true })
			.where(eq(schema.conversations.id, "conv-private"))
			.run();

		const resolved = await resolveAtlasV3LocalSources({
			userId: USER,
			conversationId: JOB_CONVERSATION,
			kickoffUserMessageId: KICKOFF,
			inheritedDisplayArtifactIds: [
				kept.sourceId,
				privateNow.sourceId,
				"artifact-deleted-since",
				foreign.sourceId,
			],
		});
		expect(resolved.documents.map((document) => document.title)).toEqual([
			"kept.pdf",
		]);
		expect(resolved.documents[0]?.origin).toBe("inherited");
		expect(
			resolved.unavailable.map((entry) => [
				entry.displayArtifactId,
				entry.origin,
				entry.reason,
			]),
		).toEqual([
			[privateNow.sourceId, "inherited", "out_of_scope"],
			["artifact-deleted-since", "inherited", "not_found"],
			[foreign.sourceId, "inherited", "not_found"],
		]);
	});

	it("returns nothing, without querying further, when the kickoff carried no document", async () => {
		const resolved = await resolveAtlasV3LocalSources({
			userId: USER,
			conversationId: JOB_CONVERSATION,
			kickoffUserMessageId: KICKOFF,
		});
		expect(resolved).toEqual({ documents: [], unavailable: [] });
	});
});

describe("selectAtlasV3LocalPassages", () => {
	it("returns passages for the goals, deduped, within maxChars", async () => {
		const chunks = [
			...BILL,
			...Array.from(
				{ length: 6 },
				(_unused, index) =>
					`Appendix ${index + 1}: the household meter log for month ${index + 1} lists kWh readings and electricity costs in detail.`,
			),
		];
		const { sourceId, normalizedId } = seedUpload({
			conversationId: JOB_CONVERSATION,
			name: "bill.pdf",
			chunks,
		});
		const document = {
			displayArtifactId: sourceId,
			promptArtifactId: normalizedId,
			title: "bill.pdf",
			origin: "attachment" as const,
			summary: null,
		};
		const passages = await selectAtlasV3LocalPassages({
			userId: USER,
			document,
			goals: [
				"household electricity kWh 2025",
				"electricity tariff per kWh",
				"household electricity kWh 2025",
			],
			maxChars: 300,
		});
		expect(passages.length).toBeGreaterThan(0);
		const chunkIndexes = passages.map((passage) => passage.chunkIndex);
		expect(new Set(chunkIndexes).size).toBe(chunkIndexes.length);
		expect([...chunkIndexes].sort((a, b) => a - b)).toEqual(chunkIndexes);
		const joined = passages.map((passage) => passage.text).join("\n---\n");
		expect(joined.length).toBeLessThanOrEqual(300);

		const wide = await selectAtlasV3LocalPassages({
			userId: USER,
			document,
			goals: ["household electricity kWh 2025"],
			maxChars: 12_000,
		});
		expect(wide.some((passage) => passage.text.includes("1,234 kWh"))).toBe(
			true,
		);
	});

	it("reads the document's opening when no passage matches any goal", async () => {
		const { sourceId, normalizedId } = seedUpload({
			conversationId: JOB_CONVERSATION,
			name: "bill.pdf",
			chunks: BILL,
		});
		const passages = await selectAtlasV3LocalPassages({
			userId: USER,
			document: {
				displayArtifactId: sourceId,
				promptArtifactId: normalizedId,
				title: "bill.pdf",
				origin: "attachment",
				summary: null,
			},
			goals: ["zzqx quux"],
			maxChars: 50,
		});
		expect(passages).toHaveLength(1);
		expect(passages[0]?.text).toHaveLength(50);
		expect(BILL[0].startsWith(passages[0]?.text ?? "-")).toBe(true);
	});
});

describe("fitAtlasV3LocalPassages", () => {
	it("cuts the passage that crosses the limit and keeps nothing after it", () => {
		const fitted = fitAtlasV3LocalPassages(
			[
				{ text: "a".repeat(10), chunkIndex: 0, pageStart: null, pageEnd: null },
				{ text: "b".repeat(10), chunkIndex: 1, pageStart: null, pageEnd: null },
				{ text: "c".repeat(10), chunkIndex: 2, pageStart: null, pageEnd: null },
			],
			20,
		);
		// 10 chars, a 5-char separator, then 5 of the second passage.
		expect(fitted.map((passage) => passage.text)).toEqual([
			"a".repeat(10),
			"b".repeat(5),
		]);
	});
});
