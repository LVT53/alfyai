import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "$lib/server/db/schema";

export const CONTEXT_COMPRESSION_TEST_NOW = new Date(
	"2026-05-25T10:00:00.000Z",
);

export const CONTEXT_COMPRESSION_TEST_CONVERSATION_ID = "conv-1";
export const CONTEXT_COMPRESSION_TEST_USER_ID = "user-1";
export const CONTEXT_COMPRESSION_TEST_TITLE = "Compression persistence";
export const CONTEXT_COMPRESSION_TEST_EMAIL = "context-compression@example.com";
export const CONTEXT_COMPRESSION_TEST_LEGACY_EMAIL =
	"context-compression-legacy@example.com";

export const CONTEXT_COMPRESSION_SOURCE_MESSAGES = [
	{
		id: "message-1",
		role: "user" as const,
		content: "First question",
		messageSequence: 1,
	},
	{
		id: "message-2",
		role: "assistant" as const,
		content: "First answer",
		messageSequence: 2,
	},
] as const;

export const CONTEXT_COMPRESSION_LEGACY_SOURCE_MESSAGES = [
	...CONTEXT_COMPRESSION_SOURCE_MESSAGES,
	{
		id: "message-3",
		role: "user" as const,
		content: "Follow-up question",
		messageSequence: 3,
		createdAtOffsetMs: 2000,
	},
	{
		id: "message-4",
		role: "assistant" as const,
		content: "Follow-up answer",
		messageSequence: 4,
		createdAtOffsetMs: 3000,
	},
] as const;

export type ContextCompressionSeedMessage = {
	id: string;
	role: "user" | "assistant";
	content: string;
	messageSequence?: number;
	createdAtOffsetMs?: number;
};

export type ContextCompressionSourceCoverageInput = {
	messageIds: string[];
	ranges?: Array<{
		startMessageId: string;
		endMessageId: string;
	}>;
};

export type ContextCompressionSnapshotResponseInput = {
	goal: string;
	currentState: string;
	importantDecisions?: string[];
	importantFacts?: string[];
	openTasks?: string[];
	openQuestions?: string[];
	toolUseAndEvidenceRefs?: Array<{
		kind: string;
		label: string;
		messageIds?: string[];
		detail?: string;
	}>;
	sourceCoverage?: ContextCompressionSourceCoverageInput;
};

export function createDefaultSourceMessages() {
	return CONTEXT_COMPRESSION_SOURCE_MESSAGES.map((message) => ({ ...message }));
}

export function createLegacySourceMessages() {
	return CONTEXT_COMPRESSION_LEGACY_SOURCE_MESSAGES.map((message) => ({
		...message,
	}));
}

export function createCompressionSnapshotResponse(
	input: ContextCompressionSnapshotResponseInput,
) {
	const snapshot = {
		goal: input.goal,
		currentState: input.currentState,
		importantDecisions: input.importantDecisions ?? [],
		importantFacts: input.importantFacts ?? [],
		openTasks: input.openTasks ?? [],
		openQuestions: input.openQuestions ?? [],
		toolUseAndEvidenceRefs: input.toolUseAndEvidenceRefs ?? [],
	};

	if (input.sourceCoverage) {
		snapshot.sourceCoverage = {
			messageIds: input.sourceCoverage.messageIds,
			...(input.sourceCoverage.ranges
				? { ranges: input.sourceCoverage.ranges }
				: {}),
		};
	}

	return snapshot;
}

export function createResolvedControlMessage(
	text: string,
	options?: {
		modelId?: string;
		modelDisplayName?: string;
		rawResponse?: Record<string, unknown>;
	},
) {
	return {
		text,
		modelId: options?.modelId ?? "model1",
		modelDisplayName: options?.modelDisplayName ?? "Selected Model",
		rawResponse: options?.rawResponse ?? {},
	};
}

export function createCompressionControlResponse(
	input: ContextCompressionSnapshotResponseInput,
	options?: {
		modelId?: string;
		modelDisplayName?: string;
		rawResponse?: Record<string, unknown>;
	},
) {
	return createResolvedControlMessage(
		JSON.stringify(createCompressionSnapshotResponse(input)),
		options,
	);
}

export function openSeedDatabase(dbPath: string) {
	const sqlite = new Database(dbPath);
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	sqlite.pragma("foreign_keys = ON");
	return { sqlite, db };
}

export function seedContextCompressionConversation(
	dbPath: string,
	base: {
		email: string;
		title: string;
		messages: ContextCompressionSeedMessage[];
	},
) {
	const { sqlite, db } = openSeedDatabase(dbPath);
	try {
		db.insert(schema.users)
			.values({
				id: CONTEXT_COMPRESSION_TEST_USER_ID,
				email: base.email,
				passwordHash: "hash",
				createdAt: CONTEXT_COMPRESSION_TEST_NOW,
				updatedAt: CONTEXT_COMPRESSION_TEST_NOW,
			})
			.run();
		db.insert(schema.conversations)
			.values({
				id: CONTEXT_COMPRESSION_TEST_CONVERSATION_ID,
				userId: CONTEXT_COMPRESSION_TEST_USER_ID,
				title: base.title,
				createdAt: CONTEXT_COMPRESSION_TEST_NOW,
				updatedAt: CONTEXT_COMPRESSION_TEST_NOW,
			})
			.run();
		db.insert(schema.messages)
			.values(
				base.messages.map((message, index) => ({
					id: message.id,
					conversationId: CONTEXT_COMPRESSION_TEST_CONVERSATION_ID,
					messageSequence: message.messageSequence ?? index + 1,
					role: message.role,
					content: message.content,
					createdAt: new Date(
						CONTEXT_COMPRESSION_TEST_NOW.getTime() +
							(message.createdAtOffsetMs ?? index * 1000),
					),
				})),
			)
			.run();
	} finally {
		sqlite.close();
	}
}
