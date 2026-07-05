#!/usr/bin/env tsx
// Seed a rich mock conversation for the visual-test@local user so the in-chat
// redesign surfaces (compaction marker, ContextUsageRing, Evidence→Sources,
// jump-rail) are exercisable in the browser. Run: npm run seed:mock.
//
// Idempotent: deletes any prior mock-seeded rows for this user first.

import { config as dotenvConfig } from "dotenv";

dotenvConfig();

if (!process.env.SESSION_SECRET)
	process.env.SESSION_SECRET =
		"test-session-secret-12345678901234567890123456789012";
if (!process.env.DATABASE_PATH) process.env.DATABASE_PATH = "./data/chat.db";

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "$lib/server/db/index";
import {
	contextCompressionSnapshots,
	conversationContextStatus,
	conversations,
	messages,
	projects,
} from "$lib/server/db/schema";

const USER_ID = "79c416c7-2053-4229-8f44-4368ffb77d61"; // visual-test@local
const MOCK_TAG = "mock-seed"; // used in titles for idempotent cleanup
const baseTs = Date.now() - 3600_000; // 1h ago (ms) → converts to Date per row

async function main() {
	// --- idempotent cleanup of any prior mock seed ---
	const priorConvos = await db
		.select({ id: conversations.id })
		.from(conversations)
		.where(
			sql`${conversations.userId} = ${USER_ID} AND ${conversations.title} LIKE ${`%${MOCK_TAG}%`}`,
		);
	for (const c of priorConvos) {
		await db
			.delete(contextCompressionSnapshots)
			.where(eq(contextCompressionSnapshots.conversationId, c.id));
		await db.delete(messages).where(eq(messages.conversationId, c.id));
		await db
			.delete(conversationContextStatus)
			.where(eq(conversationContextStatus.conversationId, c.id));
		await db.delete(conversations).where(eq(conversations.id, c.id));
	}
	await db
		.delete(projects)
		.where(
			sql`${projects.userId} = ${USER_ID} AND ${projects.name} LIKE ${`%${MOCK_TAG}%`}`,
		);

	// --- 1. project ---
	const projectId = randomUUID();
	await db.insert(projects).values({
		id: projectId,
		userId: USER_ID,
		name: `Q3 Review ${MOCK_TAG}`,
		color: "#c15f3c",
		sortOrder: 0,
	});
	console.log(`Created project: ${projectId}`);

	// --- 2. conversation ---
	const conversationId = randomUUID();
	await db.insert(conversations).values({
		id: conversationId,
		userId: USER_ID,
		title: `Q3 Revenue Deep-Dive ${MOCK_TAG}`,
		projectId,
		status: "open",
		sidebarPinned: false,
		updatedAt: new Date(baseTs),
	});
	console.log(`Created conversation: ${conversationId}`);

	// --- 3. messages: 6 user + 6 assistant, increasing createdAt ---
	type SeedMsg = {
		id: string;
		role: "user" | "assistant";
		content: string;
		ts: Date;
		evidence?: object;
	};
	const turn = (q: string, a: string, ai: number): [SeedMsg, SeedMsg] => [
		{
			id: randomUUID(),
			role: "user",
			content: q,
			ts: new Date(baseTs + ai * 60_000),
		},
		{
			id: randomUUID(),
			role: "assistant",
			content: a,
			ts: new Date(baseTs + ai * 60_000 + 30_000),
		},
	];

	const [u1, a1] = turn(
		"What were our Q3 numbers again?",
		"Revenue grew 14% YoY to $4.2M, driven mainly by enterprise expansion across the mid-market tier. The growth was broad-based but enterprise led at +22%.",
		1,
	);
	const [u2, a2] = turn(
		"Break that down by segment.",
		"Enterprise: $2.8M (+22%). SMB: $1.0M (flat). Self-serve: $0.4M (+8%). Enterprise now accounts for 67% of total revenue, up from 62% last quarter.",
		2,
	);
	const [u3, a3] = turn(
		"And the chart?",
		"Here's the segment breakdown: enterprise leads at 67% of total revenue. SMB held steady, and self-serve showed modest growth. The mix shift toward enterprise is the clearest signal.",
		3,
	);
	const [u4, a4] = turn(
		"Can you also forecast Q4?",
		"Forecasting Q4 based on current trajectory: enterprise likely to reach $3.1M, with SMB recovering slightly to $1.1M. Self-serve remains a wildcard — depends on the holiday campaign performance.",
		4,
	);
	const [u5, a5] = turn(
		"What's driving the enterprise growth specifically?",
		"Three factors: (1) the mid-market sales motion we stood up in Q2 is converting, (2) two large renewals expanded their seats, and (3) the new analytics add-on is attaching to ~40% of new deals. Net retention is at 118%.",
		5,
	);
	// attach an evidence summary to the LAST assistant message so the Sources disclosure shows
	a5.evidence = {
		groups: [
			{
				sourceType: "web" as const,
				label: "Web sources",
				reranked: false,
				items: [
					{
						id: randomUUID(),
						title: "Q3 SaaS Benchmark Report",
						sourceType: "web" as const,
						status: "selected" as const,
						url: "https://example.com/q3-saas-benchmark",
						description:
							"Industry net-retention median is 109%; we're at 118%.",
						channels: ["web" as const],
					},
					{
						id: randomUUID(),
						title: "Enterprise Sales Playbook (2024)",
						sourceType: "web" as const,
						status: "rejected" as const,
						url: "https://example.com/sales-playbook",
						description: "Set aside — predates the analytics add-on.",
					},
				],
			},
			{
				sourceType: "memory" as const,
				label: "Memory",
				reranked: false,
				items: [
					{
						id: randomUUID(),
						title: "Recent task state",
						sourceType: "memory" as const,
						status: "reference" as const,
						description:
							"Discussed Q3 numbers, segment breakdown, and the Q4 forecast in this conversation.",
					},
				],
			},
		],
		structuredWebSearch: false,
	};
	const [u6, a6] = turn(
		"Summarize the key takeaways for the board.",
		"1) Q3 revenue $4.2M (+14% YoY), enterprise-led. 2) Net retention 118% (industry-leading). 3) Q4 forecast $4.6M with enterprise at $3.1M. 4) Analytics add-on is a strong new attach driver (40% of new deals). Recommend doubling down on the mid-market motion.",
		6,
	);

	const seedMsgs = [u1, a1, u2, a2, u3, a3, u4, a4, u5, a5, u6, a6];
	for (const m of seedMsgs) {
		const metadataJson = m.evidence
			? JSON.stringify({ evidenceSummary: m.evidence, evidenceStatus: "ready" })
			: null;
		await db.insert(messages).values({
			id: m.id,
			conversationId,
			role: m.role,
			content: m.content,
			metadataJson,
			// leave messageSequence null — auto-repaired on read
			createdAt: m.ts,
		});
	}
	console.log(`Inserted ${seedMsgs.length} messages`);

	// --- 4. compaction snapshot (valid, mid-conversation, after a3) ---
	// Position the marker after the 6th message (a3) so it appears mid-thread.
	const sourceEnd = a3.id; // marker renders after this message
	const sourceStart = u1.id;
	const compactedIds = [u1.id, a1.id, u2.id, a2.id, u3.id, a3.id];
	await db.insert(contextCompressionSnapshots).values({
		id: randomUUID(),
		conversationId,
		userId: USER_ID,
		trigger: "automatic",
		status: "valid",
		modelId: "model1",
		sourceStartMessageId: sourceStart,
		sourceEndMessageId: sourceEnd,
		sourceStartMessageSequence: 1,
		sourceEndMessageSequence: 6,
		snapshotJson: JSON.stringify({
			goal: "Analyze Q3 revenue performance and segment dynamics.",
			currentState:
				"Established Q3 total ($4.2M, +14% YoY) and the enterprise-led segment breakdown (67% of revenue).",
			importantDecisions: [
				"Focus the deep-dive on enterprise as the growth driver.",
			],
			importantFacts: [
				"Net retention at 118% — industry-leading vs 109% median.",
			],
			openTasks: [],
			openQuestions: [],
			toolUseAndEvidenceRefs: [],
			sourceCoverage: { messageIds: compactedIds },
		}),
		sourceCoverageJson: JSON.stringify({ messageIds: compactedIds }),
		sourceRefsJson: "[]",
		estimatedTokens: 320,
		sourceTokenEstimate: 2800,
		createdAt: new Date(baseTs + 4 * 60_000),
		updatedAt: new Date(baseTs + 4 * 60_000),
	});
	console.log(
		`Inserted compaction snapshot (marker after message ${sourceEnd})`,
	);

	// --- 5. context status (ring at ~62%) ---
	await db.insert(conversationContextStatus).values({
		conversationId,
		userId: USER_ID,
		estimatedTokens: 98000,
		maxContextTokens: 262144,
		thresholdTokens: 209715,
		targetTokens: 157286,
		compactionApplied: 1,
		compactionMode: "llm_fallback",
		routingStage: "deterministic",
		routingConfidence: 0,
		verificationStatus: "skipped",
		layersUsedJson: JSON.stringify(["documents", "outputs", "session"]),
		workingSetCount: 0,
		workingSetApplied: 0,
		taskStateApplied: 1,
		promptArtifactCount: 0,
		recentTurnCount: 6,
		summary: "Q3 revenue deep-dive",
	});
	console.log(`Inserted context status (ring ~62%)`);

	console.log(`\nDone. Open: http://localhost:4173/chat/${conversationId}`);
	console.log(
		`(npm run dev -- --port 4173 first, then log in as visual-test@local)`,
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
