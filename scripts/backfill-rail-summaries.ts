#!/usr/bin/env tsx
// One-time backfill: generate the durable jump-rail summary (railSummary) for
// EXISTING assistant messages that predate the Tier A1 feature, so older chats
// show glanceable summaries without a first-hover lag. Idempotent: skips any
// assistant message that already has a railSummary, and reuses the exact
// production generation path (persistAssistantRailSummary -> generateShortLocalText
// -> updateMessageRailSummary), which itself skips replies shorter than the
// 200-char threshold. Sequential + gentle so it doesn't burst the shared vLLM.
//
// Run it in the deployed release dir on the box (uses the prod DB + model config):
//   cd /home/alfydesign/apps/langflow-chat/current && npx tsx scripts/backfill-rail-summaries.ts
// Flags: --dry-run (count only, no model calls / no writes), --limit N, --user <email>.
import { config as dotenvConfig } from "dotenv";

dotenvConfig();
if (!process.env.SESSION_SECRET)
	process.env.SESSION_SECRET =
		"test-session-secret-12345678901234567890123456789012";
if (!process.env.DATABASE_PATH) process.env.DATABASE_PATH = "./data/chat.db";

import { asc, eq } from "drizzle-orm";
import { db } from "$lib/server/db/index";
import { conversations, messages, users } from "$lib/server/db/schema";
import { persistAssistantRailSummary } from "$lib/server/services/chat-turn/rail-summary";

function hasRailSummary(metadataJson: string | null): boolean {
	if (!metadataJson) return false;
	try {
		const meta = JSON.parse(metadataJson) as { railSummary?: unknown };
		return (
			typeof meta.railSummary === "string" && meta.railSummary.trim().length > 0
		);
	} catch {
		return false;
	}
}

async function main() {
	const args = process.argv.slice(2);
	const dryRun = args.includes("--dry-run");
	const limitArg = args.find((a) => a.startsWith("--limit="));
	const userArg = args.find((a) => a.startsWith("--user="));
	const limit = limitArg ? Number(limitArg.split("=")[1]) : Infinity;
	const userEmail = userArg ? userArg.split("=")[1] : null;

	let onlyUserId: string | null = null;
	if (userEmail) {
		const u = (
			await db
				.select({ id: users.id })
				.from(users)
				.where(eq(users.email, userEmail))
		)[0];
		if (!u) throw new Error(`no user with email ${userEmail}`);
		onlyUserId = u.id;
		console.log(`Filtering to user ${userEmail} (${onlyUserId}).`);
	}

	const convos = await db
		.select({ id: conversations.id, userId: conversations.userId })
		.from(conversations);

	let processed = 0;
	let generated = 0;
	let alreadyHad = 0;
	let failed = 0;

	for (const convo of convos) {
		if (onlyUserId && convo.userId !== onlyUserId) continue;
		const msgs = await db
			.select({
				id: messages.id,
				role: messages.role,
				content: messages.content,
				metadataJson: messages.metadataJson,
			})
			.from(messages)
			.where(eq(messages.conversationId, convo.id))
			.orderBy(asc(messages.createdAt));

		let lastUserMessage = "";
		for (const m of msgs) {
			if (m.role === "user") {
				lastUserMessage = m.content;
				continue;
			}
			if (m.role !== "assistant") continue;
			if (hasRailSummary(m.metadataJson)) {
				alreadyHad++;
				continue;
			}
			if (processed >= limit) break;
			processed++;
			if (dryRun) continue;
			try {
				const before = m.metadataJson;
				await persistAssistantRailSummary({
					userId: convo.userId,
					conversationId: convo.id,
					assistantMessageId: m.id,
					userMessage: lastUserMessage,
					assistantResponse: m.content,
				});
				// Re-read to tell "generated" from "skipped-because-short/failed-degrade".
				const after = (
					await db
						.select({ metadataJson: messages.metadataJson })
						.from(messages)
						.where(eq(messages.id, m.id))
				)[0]?.metadataJson;
				if (after !== before && hasRailSummary(after ?? null)) generated++;
			} catch (err) {
				failed++;
				console.warn(
					`  fail ${m.id}:`,
					err instanceof Error ? err.message : err,
				);
			}
			if (processed % 20 === 0) {
				console.log(
					`  ...${processed} candidates processed (${generated} generated)`,
				);
			}
		}
		if (processed >= limit) break;
	}

	console.log(
		`\nBackfill ${dryRun ? "(dry-run) " : ""}complete: candidates=${processed}, generated=${generated}, alreadyHad=${alreadyHad}, failed=${failed}`,
	);
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
