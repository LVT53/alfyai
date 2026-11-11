import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import type { ChatMessage } from "$lib/server/services/messages-types";

type ReadFault =
	| "ledger"
	| "usage"
	| "legacy"
	| "summary"
	| "privacy"
	| "privacy-absent"
	| "core"
	| "attachments";
export async function accountingReadFixture() {
	const directory = mkdtempSync(join(tmpdir(), "accounting-reads-"));
	const path = join(directory, "scratch.sqlite");
	const connection = new Database(path);
	migrate(drizzle(connection), { migrationsFolder: "./drizzle" });
	connection.close();
	vi.resetModules();
	vi.stubEnv("DATABASE_PATH", path);
	const database = await import("$lib/server/db");
	const { db, sqlite } = database;
	db.insert(schema.users)
		.values({ id: "u", email: "accounting@test.invalid", passwordHash: "x" })
		.run();
	db.insert(schema.conversations)
		.values([
			{ id: "c", userId: "u", title: "Synthetic" },
			{ id: "empty", userId: "u", title: "Empty" },
		])
		.run();
	db.insert(schema.providers)
		.values({
			id: "p",
			name: "test",
			displayName: "Test",
			baseUrl: "https://test.invalid",
			apiKeyEncrypted: "x",
			apiKeyIv: "x",
		})
		.run();
	db.insert(schema.providerModels)
		.values({
			id: "m",
			providerId: "p",
			name: "test",
			displayName: "Test",
			inputUsdMicrosPer1m: 1_000_000,
			outputUsdMicrosPer1m: 2_000_000,
		})
		.run();
	const readers = await import("$lib/server/services/messages");
	const analytics = await import("$lib/server/services/analytics");
	let sequence = 0;
	function message(
		id: string,
		role: "user" | "assistant" = "assistant",
		metadata: Record<string, unknown> = {},
		conversationId = "c",
	) {
		sequence++;
		db.insert(schema.messages)
			.values({
				id,
				conversationId,
				role,
				content: `Body ${id}`,
				messageSequence: sequence,
				createdAt: new Date(1_800_000_000_000 + sequence * 1000),
				thinking: role === "assistant" ? "Saved thought" : null,
				toolCalls:
					role === "assistant"
						? JSON.stringify([{ type: "thinking", content: "Saved thought" }])
						: null,
				metadataJson: JSON.stringify(metadata),
			})
			.run();
	}
	function legacy(id: string, cost = 42) {
		db.insert(schema.usageEvents)
			.values({
				id: `usage-${id}`,
				userId: "u",
				conversationId: "c",
				messageId: id,
				modelId: "provider:p:m",
				modelDisplayName: "Accounting display",
				generationTimeMs: 9999,
				costUsdMicros: cost,
				completionTokens: 4,
				reasoningTokens: 1,
				totalTokens: 14,
				billingMonth: "2026-11",
			})
			.run();
		db.insert(schema.messageAnalytics)
			.values({
				id: `legacy-${id}`,
				messageId: id,
				userId: "u",
				model: "provider:p:m",
				generationTimeMs: 8888,
			})
			.run();
	}
	async function seed() {
		message("u1", "user");
		message("a1", "assistant", {
			modelDisplayName: "Saved display",
			providerDisplayName: "Saved provider",
			providerIconUrl: "/saved-icon.png",
			railSummary: "Saved rail",
			thoughtSteps: [
				{
					id: "step",
					source: "classified",
					activityClass: "understanding-request",
					impliesExternalAction: false,
					anchor: { start: 0, end: 12 },
					createdAt: 1000,
				},
			],
			continuesMessageId: "earlier",
			normalChatOutput: { version: 1, events: [] },
		});
		legacy("a1");
		message("u2", "user");
		message("a2");
		const ledger = await import("$lib/server/services/chat-turn/turn-ledger");
		const scope = {
			userId: "u",
			conversationId: "c",
			turnId: "turn",
			segmentId: "segment",
		};
		ledger.admitTurn({ ...scope, ownerId: "synthetic-owner" });
		await ledger.recordTurnAttempt(scope, {
			attemptId: "attempt",
			phase: "working",
			providerId: "p",
			modelId: "provider:p:m",
			providerModelName: "test",
			safeStopCause: null,
			outcome: null,
			inputTokens: 100,
			outputTokens: 20,
			totalTokens: 120,
			reasoningTokens: 5,
			generationTimeMs: 1000,
			usageFinal: true,
		});
		ledger.settleTurn(scope, {
			phase: "working",
			outcome: "answered",
			stopCause: "natural_stop",
			workingStopCause: "natural_stop",
			closingAttempted: false,
			recoveryCount: 0,
			attemptIds: ["attempt"],
			messageId: "a2",
		});
		legacy("a2", 999999);
		db.insert(schema.artifacts)
			.values({
				id: "attachment",
				userId: "u",
				conversationId: "c",
				type: "document",
				name: "fixture.txt",
				contentText: "Synthetic attachment",
			})
			.run();
		db.insert(schema.artifactLinks)
			.values({
				id: "attachment-link",
				userId: "u",
				conversationId: "c",
				artifactId: "attachment",
				messageId: "u1",
				linkType: "attached_to_conversation",
			})
			.run();
	}
	const originalPrepare = sqlite.prepare.bind(sqlite);
	const counts: Record<string, number> = {};
	let active: { kind: ReadFault; nth: number } | undefined;
	const spy = vi
		.spyOn(sqlite, "prepare")
		.mockImplementation((query: string) => {
			if (/^select\b/i.test(query)) {
				const kinds: ReadFault[] = [];
				if (query.includes('"normal_chat_turns"')) kinds.push("ledger");
				if (query.includes('"usage_events"'))
					kinds.push(/sum\(/i.test(query) ? "summary" : "usage");
				if (query.includes('"message_analytics"')) kinds.push("legacy");
				if (
					/from "conversations"/.test(query) &&
					query.includes('"memory_incognito"')
				)
					kinds.push("privacy", "privacy-absent");
				if (/from "messages"/.test(query) && !query.includes('"usage_events"'))
					kinds.push("core");
				if (
					/from "artifact_links"/.test(query) &&
					query.includes('"artifacts"')
				)
					kinds.push("attachments");
				for (const kind of kinds) {
					counts[kind] = (counts[kind] ?? 0) + 1;
					if (active?.kind === kind && counts[kind] === active.nth) {
						if (kind === "privacy-absent")
							return originalPrepare("select ? where 0");
						throw new Error(`injected-${kind}`);
					}
				}
			}
			return originalPrepare(query);
		});
	function fault(kind?: ReadFault, nth = 1) {
		for (const key of Object.keys(counts)) delete counts[key];
		active = kind ? { kind, nth } : undefined;
	}
	function facts() {
		return [
			schema.messages,
			schema.usageEvents,
			schema.messageAnalytics,
			schema.normalChatTurns,
			schema.normalChatAttempts,
		].map((table) => db.select().from(table).all());
	}
	return {
		db,
		sqlite,
		readers,
		analytics,
		message,
		legacy,
		seed,
		fault,
		counts,
		facts,
		close() {
			spy.mockRestore();
			sqlite.close();
			vi.unstubAllEnvs();
			rmSync(directory, { recursive: true, force: true });
		},
	};
}
export function durable(rows: ChatMessage[]) {
	return rows.map(
		({
			costUsd: _cost,
			responseTokenCount: _response,
			thinkingTokenCount: _thinking,
			totalTokenCount: _total,
			generationDurationMs: _duration,
			modelId: _model,
			modelDisplayName: _display,
			...rest
		}) => rest,
	);
}
export function expectUnknown(rows: ChatMessage[]) {
	for (const row of rows.filter((row) => row.role === "assistant")) {
		for (const field of [
			"costUsd",
			"responseTokenCount",
			"thinkingTokenCount",
			"totalTokenCount",
			"generationDurationMs",
		] as const) {
			if (row[field] !== undefined)
				throw new Error(`Unexpected ${field} on ${row.id}`);
		}
	}
}
