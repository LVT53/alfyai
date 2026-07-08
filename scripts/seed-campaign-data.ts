#!/usr/bin/env tsx
// Seed representative demo data for the campaign-preview@local user so
// release-campaign screenshots (memory Knowledge page, chat jump-rail,
// incognito mode, ContextUsageRing, Sources tab, compaction marker, etc.)
// have realistic, PG content instead of empty states.
//
// Idempotent: wipes prior data owned by this user (conversations, projects,
// memory profile/consolidation/review rows, usage events) before reseeding.
// Run: npx tsx scripts/seed-campaign-data.ts

import { config as dotenvConfig } from "dotenv";

dotenvConfig();

if (!process.env.SESSION_SECRET)
	process.env.SESSION_SECRET =
		"campaign-seed-session-secret-12345678901234567890";
if (!process.env.DATABASE_PATH) process.env.DATABASE_PATH = "./data/chat.db";

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "$lib/server/db/index";
import {
	contextCompressionSnapshots,
	conversationContextStatus,
	conversations,
	memoryConsolidationReports,
	memoryProfileItems,
	memoryProjectionState,
	memoryReviewItems,
	messages,
	projects,
	usageEvents,
} from "$lib/server/db/schema";

const USER_ID = "2b860f30-f106-416a-aac1-51d636b43b9a"; // campaign-preview@local
const USER_EMAIL = "campaign-preview@local";
const USER_NAME = "Campaign Preview";

async function wipePriorSeed() {
	// Conversations cascade-delete messages, context status, and compaction
	// snapshots. Memory projection state cascade-deletes profile items +
	// provenance. Everything else is deleted directly by userId.
	const priorConvos = await db
		.select({ id: conversations.id })
		.from(conversations)
		.where(eq(conversations.userId, USER_ID));
	for (const c of priorConvos) {
		await db.delete(conversations).where(eq(conversations.id, c.id));
	}
	await db.delete(projects).where(eq(projects.userId, USER_ID));
	await db
		.delete(memoryProjectionState)
		.where(eq(memoryProjectionState.userId, USER_ID));
	await db
		.delete(memoryConsolidationReports)
		.where(eq(memoryConsolidationReports.userId, USER_ID));
	await db
		.delete(memoryReviewItems)
		.where(eq(memoryReviewItems.userId, USER_ID));
	await db.delete(usageEvents).where(eq(usageEvents.userId, USER_ID));
}

async function main() {
	await wipePriorSeed();

	const now = Date.now();

	// ---------------------------------------------------------------------
	// 1. Memory: projection state (persona summary) + profile items
	// ---------------------------------------------------------------------
	const projectionStateId = randomUUID();
	await db.insert(memoryProjectionState).values({
		id: projectionStateId,
		userId: USER_ID,
		resetGeneration: 0,
		scopeType: "global",
		scopeId: "",
		revision: 1,
		status: "ready",
		lastRefreshedAt: new Date(now),
		personaSummaryText:
			"You're a product manager on a mid-size B2B SaaS analytics team, based in Berlin, " +
			"currently leading the Q3 revenue deep-dive for the board. You favor concise, " +
			"bullet-point answers with charts over long prose, and you keep dark mode on " +
			"everywhere from code editors to docs. You're balancing that work against family " +
			"time — two kids and a preference for keeping weekdays contained to 9-to-5 — and " +
			"you've been chipping away at learning Hungarian on the side. Budget is tight this " +
			"year, so you steer away from enterprise-only tooling when cheaper options exist.",
		personaSummaryLinksJson: "[]",
		personaSummaryUpdatedAt: new Date(now - 2 * 3600_000),
		createdAt: new Date(now - 30 * 86_400_000),
		updatedAt: new Date(now - 2 * 3600_000),
	});

	type ItemSeed = {
		key: string;
		category:
			| "about_you"
			| "preferences"
			| "goals_ongoing_work"
			| "constraints_boundaries";
		statement: string;
		status: "active" | "review_needed" | "retired";
		metadata?: Record<string, unknown>;
	};

	const items: ItemSeed[] = [
		// about_you
		{
			key: "about-you-role",
			category: "about_you",
			statement:
				"I'm a product manager at a mid-size B2B SaaS company, focused on the analytics team.",
			status: "active",
		},
		{
			key: "about-you-location",
			category: "about_you",
			statement:
				"I live in Berlin and work mostly async with a distributed team.",
			status: "active",
		},
		{
			key: "about-you-family",
			category: "about_you",
			statement:
				"I have two kids and try to keep work contained to 9-5 on weekdays.",
			status: "active",
		},
		{
			key: "about-you-hungarian",
			category: "about_you",
			statement: "I've been learning Hungarian for the past year.",
			status: "active",
		},
		{
			key: "about-you-role-change",
			category: "about_you",
			statement:
				"I might be switching to a new role focused on platform strategy next quarter.",
			status: "review_needed",
		},
		// preferences
		{
			key: "pref-concise",
			category: "preferences",
			statement: "I prefer concise, bullet-point answers over long prose.",
			status: "active",
		},
		{
			key: "pref-dark-mode",
			category: "preferences",
			statement:
				"I like dark mode everywhere, including in code editors and docs.",
			status: "active",
		},
		{
			key: "pref-charts",
			category: "preferences",
			statement: "I want charts included whenever I ask for data breakdowns.",
			status: "active",
		},
		{
			key: "pref-hungarian-lang",
			category: "preferences",
			statement:
				"I may prefer Hungarian-language responses for personal topics.",
			status: "review_needed",
		},
		// goals_ongoing_work
		{
			key: "goal-q3-deepdive",
			category: "goals_ongoing_work",
			statement:
				"Currently leading the Q3 revenue deep-dive analysis for the board.",
			status: "active",
		},
		{
			key: "goal-pipeline-migration",
			category: "goals_ongoing_work",
			statement:
				"Working on migrating the analytics pipeline to the new warehouse.",
			status: "active",
		},
		{
			key: "goal-onboarding-redesign",
			category: "goals_ongoing_work",
			statement:
				"Long-term goal: ship the self-serve onboarding redesign by year end.",
			status: "active",
		},
		// constraints_boundaries
		{
			key: "constraint-budget",
			category: "constraints_boundaries",
			statement:
				"Don't suggest solutions that require enterprise-only tooling — budget is tight this year.",
			status: "active",
		},
		{
			key: "constraint-revenue-privacy",
			category: "constraints_boundaries",
			statement: "Never share specific revenue figures outside internal docs.",
			status: "active",
		},
		{
			key: "constraint-hours",
			category: "constraints_boundaries",
			statement: "Keep meeting-related suggestions within CET business hours.",
			status: "active",
		},
		// retired items feeding the consolidation timeline (superseded / merged)
		{
			key: "goal-legacy-dashboard-rewrite",
			category: "goals_ongoing_work",
			statement: "Working on the legacy reporting dashboard rewrite.",
			status: "retired",
		},
		{
			key: "pref-ide-dark-theme",
			category: "preferences",
			statement: "I like using dark themes in my IDE.",
			status: "retired",
		},
		{
			key: "pref-high-contrast",
			category: "preferences",
			statement: "I prefer high-contrast UI everywhere.",
			status: "active",
		},
	];

	const idByKey = new Map<string, string>();
	for (const item of items) {
		const id = randomUUID();
		idByKey.set(item.key, id);
		await db.insert(memoryProfileItems).values({
			id,
			userId: USER_ID,
			projectionStateId,
			resetGeneration: 0,
			itemKey: `campaign-${item.key}`,
			category: item.category,
			scopeType: "global",
			scopeId: "",
			statement: item.statement,
			status: item.status,
			revision: 1,
			metadataJson: JSON.stringify(
				item.metadata ?? { origin: "consolidation_seed" },
			),
			createdAt: new Date(now - 20 * 86_400_000),
			updatedAt: new Date(
				now - (item.status === "retired" ? 3 : 1) * 86_400_000,
			),
		});
	}
	console.log(`Inserted ${items.length} memory profile items`);

	// Note: pref-high-contrast is actually the *merge target* below, so flip it
	// to the merged/active winner statement after all ids are known.
	const mergedWinnerId = randomUUID();
	await db.insert(memoryProfileItems).values({
		id: mergedWinnerId,
		userId: USER_ID,
		projectionStateId,
		resetGeneration: 0,
		itemKey: "campaign-pref-dark-mode-merged",
		category: "preferences",
		scopeType: "global",
		scopeId: "",
		statement:
			"I like dark mode everywhere — high-contrast dark themes in my IDE, editors, and docs.",
		status: "active",
		revision: 1,
		metadataJson: JSON.stringify({ origin: "consolidation" }),
		createdAt: new Date(now - 3 * 86_400_000),
		updatedAt: new Date(now - 3 * 86_400_000),
	});
	// Remove the placeholder duplicate "pref-high-contrast" active row so it
	// doesn't double up with the merged winner in the Preferences card.
	const highContrastId = idByKey.get("pref-high-contrast");
	if (highContrastId) {
		await db
			.delete(memoryProfileItems)
			.where(eq(memoryProfileItems.id, highContrastId));
	}

	// ---------------------------------------------------------------------
	// 2. Memory review items (surfaces the two review_needed facts above in
	//    the Knowledge page's "Needs review" queue)
	// ---------------------------------------------------------------------
	const roleChangeItemId = idByKey.get("about-you-role-change");
	const hungarianLangItemId = idByKey.get("pref-hungarian-lang");
	await db.insert(memoryReviewItems).values([
		{
			id: randomUUID(),
			userId: USER_ID,
			resetGeneration: 0,
			subjectKey: "campaign-review-role-change",
			subjectLabel: "Possible upcoming role change",
			question:
				"Should I start treating the platform-strategy role as confirmed?",
			reason:
				"Mentioned once, not confirmed yet — flagged for review before trusting it.",
			status: "open",
			affectedItemIdsJson: JSON.stringify(
				roleChangeItemId ? [roleChangeItemId] : [],
			),
			evidenceJson: "[]",
			metadataJson: JSON.stringify({ category: "about_you" }),
			createdAt: new Date(now - 2 * 86_400_000),
			updatedAt: new Date(now - 2 * 86_400_000),
		},
		{
			id: randomUUID(),
			userId: USER_ID,
			resetGeneration: 0,
			subjectKey: "campaign-review-hungarian-lang",
			subjectLabel: "Hungarian-language responses for personal topics",
			question: "Should replies about personal topics default to Hungarian?",
			reason:
				"Only came up once in passing — confirm before applying it broadly.",
			status: "open",
			affectedItemIdsJson: JSON.stringify(
				hungarianLangItemId ? [hungarianLangItemId] : [],
			),
			evidenceJson: "[]",
			metadataJson: JSON.stringify({ category: "preferences" }),
			createdAt: new Date(now - 1 * 86_400_000),
			updatedAt: new Date(now - 1 * 86_400_000),
		},
	]);
	console.log("Inserted 2 memory review items");

	// ---------------------------------------------------------------------
	// 3. Consolidation report: one "superseded" + one "merged" action, both
	//    resolving to real (active) resultItemId targets.
	// ---------------------------------------------------------------------
	const legacyDashboardId = idByKey.get("goal-legacy-dashboard-rewrite");
	const pipelineMigrationId = idByKey.get("goal-pipeline-migration");
	const ideDarkThemeId = idByKey.get("pref-ide-dark-theme");

	const actions = [
		{
			type: "superseded",
			itemIds: legacyDashboardId ? [legacyDashboardId] : [],
			resultItemId: pipelineMigrationId,
			description:
				'Retired "Working on the legacy reporting dashboard rewrite." as superseded by a newer fact.',
			undo: legacyDashboardId
				? [
						{
							itemId: legacyDashboardId,
							prevStatus: "active",
							prevStatement:
								"Working on the legacy reporting dashboard rewrite.",
						},
					]
				: [],
		},
		{
			type: "merged",
			itemIds: [ideDarkThemeId, highContrastId].filter(Boolean),
			resultItemId: mergedWinnerId,
			description:
				'Merged 2 duplicate facts into "I like dark mode everywhere — high-contrast dark themes in my IDE, editors, and docs."',
			undo: [
				ideDarkThemeId
					? {
							itemId: ideDarkThemeId,
							prevStatus: "active",
							prevStatement: "I like using dark themes in my IDE.",
						}
					: null,
				highContrastId
					? {
							itemId: highContrastId,
							prevStatus: "active",
							prevStatement: "I prefer high-contrast UI everywhere.",
						}
					: null,
			].filter(Boolean),
		},
	];

	await db.insert(memoryConsolidationReports).values({
		id: randomUUID(),
		userId: USER_ID,
		resetGeneration: 0,
		status: "succeeded",
		summaryText:
			"Consolidated 2 duplicate/stale facts: retired an outdated goal and merged two overlapping display preferences.",
		actionsJson: JSON.stringify(actions),
		createdAt: new Date(now - 3 * 86_400_000),
	});
	console.log("Inserted 1 consolidation report (superseded + merged actions)");

	// ---------------------------------------------------------------------
	// 4. Project + conversation with ~6 turns, evidence on the last assistant
	//    message (Sources tab), a compaction snapshot, context status, and
	//    usage events (ContextUsageRing cost line).
	// ---------------------------------------------------------------------
	const projectId = randomUUID();
	await db.insert(projects).values({
		id: projectId,
		userId: USER_ID,
		name: "Q3 Revenue Program",
		color: "#c15f3c",
		sortOrder: 0,
	});

	const conversationId = randomUUID();
	const baseTs = now - 3600_000;
	await db.insert(conversations).values({
		id: conversationId,
		userId: USER_ID,
		title: "Q3 Revenue Deep-Dive",
		projectId,
		status: "open",
		sidebarPinned: true,
		updatedAt: new Date(baseTs),
	});

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
			createdAt: m.ts,
		});
	}
	console.log(
		`Inserted ${seedMsgs.length} messages into "Q3 Revenue Deep-Dive"`,
	);

	// Compaction snapshot (valid, mid-conversation, marker after a3).
	const sourceEnd = a3.id;
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

	// Context status (ring ~62%, compaction applied).
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
	console.log("Inserted context status (ring ~62%)");

	// Usage events: one per assistant message, summing to a clean ~$1.85 /
	// ~48.3K tokens total so the ContextUsageRing cost line reads
	// "$1.85 · 48.3K tokens" without wrapping.
	const assistantTurns = [a1, a2, a3, a4, a5, a6];
	const perTurnCostMicros = [220000, 260000, 240000, 310000, 480000, 340000]; // sums to 1,850,000
	const perTurnTokens = [5200, 6100, 5800, 8200, 12400, 10600]; // sums to 48,300
	const billingMonth = new Date(baseTs).toISOString().slice(0, 7);
	for (let i = 0; i < assistantTurns.length; i++) {
		const msg = assistantTurns[i];
		await db.insert(usageEvents).values({
			id: randomUUID(),
			userId: USER_ID,
			userEmail: USER_EMAIL,
			userName: USER_NAME,
			conversationId,
			conversationTitle: "Q3 Revenue Deep-Dive",
			messageId: msg.id,
			modelId: "model1",
			modelDisplayName: "Model One",
			providerId: "campaign-preview",
			providerDisplayName: "Campaign Preview Provider",
			promptTokens: Math.round(perTurnTokens[i] * 0.7),
			completionTokens: Math.round(perTurnTokens[i] * 0.3),
			totalTokens: perTurnTokens[i],
			usageSource: "estimated",
			generationTimeMs: 1800 + i * 150,
			billingMonth,
			costUsdMicros: perTurnCostMicros[i],
			createdAt: msg.ts,
		});
	}
	console.log(
		"Inserted 6 usage events (~$1.85 / ~48.3K tokens total for ContextUsageRing)",
	);

	// ---------------------------------------------------------------------
	// 5. Incognito conversation (memory_incognito = true)
	// ---------------------------------------------------------------------
	const incognitoConversationId = randomUUID();
	await db.insert(conversations).values({
		id: incognitoConversationId,
		userId: USER_ID,
		title: "Weekend trip planning",
		projectId: null,
		status: "open",
		memoryIncognito: true,
		updatedAt: new Date(now - 10 * 60_000),
	});
	const incognitoUserMsgId = randomUUID();
	const incognitoAssistantMsgId = randomUUID();
	await db.insert(messages).values([
		{
			id: incognitoUserMsgId,
			conversationId: incognitoConversationId,
			role: "user",
			content:
				"Any ideas for a quiet long weekend near Berlin, nothing work-related?",
			createdAt: new Date(now - 9 * 60_000),
		},
		{
			id: incognitoAssistantMsgId,
			conversationId: incognitoConversationId,
			role: "assistant",
			content:
				"A few low-key options within a couple hours: the Spreewald canals for a slow paddling trip, Rheinsberg for lakeside walks and a small palace, or the Baltic coast near Ahrenshoop if you don't mind a longer drive. All good for switching off completely.",
			createdAt: new Date(now - 8 * 60_000),
		},
	]);
	console.log("Inserted incognito conversation: Weekend trip planning");

	console.log("\nDone. Campaign data seeded for campaign-preview@local.");
	console.log(`Main conversation: /chat/${conversationId}`);
	console.log(`Incognito conversation: /chat/${incognitoConversationId}`);
	console.log(`Knowledge page: /knowledge`);
}

main()
	.catch((err) => {
		console.error(err);
		process.exit(1);
	})
	.finally(() => {
		process.exit(0);
	});
