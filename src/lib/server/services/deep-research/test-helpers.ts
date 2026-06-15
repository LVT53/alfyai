import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "$lib/server/db/schema";
import type { DeepResearchJob, DeepResearchPassDecision } from "$lib/types";
import type { SynthesisNotes } from "./synthesis";

interface DeepResearchConversationSeedInput {
	dbPath: string;
	userId?: string;
	conversationId?: string;
	messageId?: string;
	userRequest?: string;
	userEmail?: string;
	now?: Date;
}

export const deepResearchDefaultUserId = "user-1";
export const deepResearchDefaultConversationId = "conv-1";
export const deepResearchDefaultMessageId = "user-msg-1";
export const deepResearchDefaultUserRequest =
	"Compare EU and US AI copyright training data rules";

function toDateTime(value: Date | string | number): Date {
	if (value instanceof Date) return value;
	return new Date(value);
}

export async function seedDeepResearchConversation(
	input: DeepResearchConversationSeedInput,
): Promise<void> {
	const {
		dbPath,
		userId = deepResearchDefaultUserId,
		conversationId = deepResearchDefaultConversationId,
		messageId = deepResearchDefaultMessageId,
		userRequest = deepResearchDefaultUserRequest,
		userEmail = "user@example.com",
		now = new Date("2026-05-05T10:00:00.000Z"),
	} = input;

	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });

	db.insert(schema.users)
		.values({
			id: userId,
			email: userEmail,
			passwordHash: "hash",
		})
		.run();
	db.insert(schema.conversations)
		.values({
			id: conversationId,
			userId,
			title: "Research conversation",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.messages)
		.values({
			id: messageId,
			conversationId,
			role: "user",
			content: userRequest,
			createdAt: now,
		})
		.run();

	sqlite.close();
}

export async function seedAdditionalConversation(
	dbPath: string,
	input: {
		conversationId: string;
		messageId: string;
		userId?: string;
		userRequest?: string;
	},
): Promise<void> {
	const {
		conversationId,
		messageId,
		userId = deepResearchDefaultUserId,
		userRequest = deepResearchDefaultUserRequest,
	} = input;
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	const now = new Date("2026-05-05T10:00:00.000Z");

	db.insert(schema.conversations)
		.values({
			id: conversationId,
			userId,
			title: "Research conversation",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.messages)
		.values({
			id: messageId,
			conversationId,
			role: "user",
			content: userRequest,
			createdAt: now,
		})
		.run();

	sqlite.close();
}

export async function assignConversationToResearchProject(
	dbPath: string,
): Promise<void> {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	const now = new Date("2026-05-05T10:00:00.000Z");

	db.insert(schema.projects)
		.values({
			id: "project-1",
			userId: deepResearchDefaultUserId,
			name: "Research folder",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.update(schema.conversations)
		.set({ projectId: "project-1" })
		.where(eq(schema.conversations.id, deepResearchDefaultConversationId))
		.run();

	sqlite.close();
}

export async function seedCompletedMeaningfulPasses(
	jobId: string,
	count: number,
	options?: {
		userId?: string;
		conversationId?: string;
		startPassNumber?: number;
		searchIntent?: (passNumber: number) => string;
		nextDecision?: DeepResearchPassDecision;
		decisionSummary?: string;
	},
): Promise<void> {
	const {
		userId = deepResearchDefaultUserId,
		conversationId = deepResearchDefaultConversationId,
		startPassNumber = 1,
		nextDecision = "synthesize_report",
	} = options ?? {};
	const { upsertResearchPassCheckpoint, completeResearchPassCheckpoint } =
		await import("./pass-state");

	for (let index = 0; index < count; index += 1) {
		const passNumber = startPassNumber + index;
		const checkpoint = await upsertResearchPassCheckpoint({
			userId,
			jobId,
			conversationId,
			passNumber,
			searchIntent:
				options?.searchIntent?.(passNumber) ??
				(passNumber === 1
					? "Initial approved-plan source review"
					: `Targeted follow-up for pass ${passNumber - 1} Coverage Gaps`),
			reviewedSourceIds: [],
			now: new Date(
				`2026-05-05T10:${String(10 + index).padStart(2, "0")}:00.000Z`,
			),
		});
		await completeResearchPassCheckpoint({
			userId,
			checkpointId: checkpoint.id,
			nextDecision,
			decisionSummary:
				options?.decisionSummary ??
				"Fixture completed meaningful research pass.",
			now: toDateTime(
				`2026-05-05T10:${String(10 + index).padStart(2, "0")}:30.000Z`,
			),
		});
	}
}

function makeSupportedFinding(input: {
	jobId: string;
	sourceId: string;
	url: string;
	title: string;
	statement: string;
}): SynthesisNotes {
	const finding = {
		kind: "supported" as const,
		statement: input.statement,
		sourceRefs: [
			{
				reviewedSourceId: input.sourceId,
				discoveredSourceId: input.sourceId,
				canonicalUrl: input.url,
				title: input.title,
			},
		],
	};
	return {
		jobId: input.jobId,
		findings: [finding],
		supportedFindings: [finding],
		conflicts: [],
		assumptions: [],
		reportLimitations: [],
	};
}

export function buildStandardSupportingFinding(input: {
	jobId: string;
	sourceId: string;
	url: string;
	title: string;
}): SynthesisNotes {
	return makeSupportedFinding({
		...input,
		statement:
			"EU and US AI copyright training data rules require provenance records and rights-risk review.",
	});
}

export function buildSupportingFindingsForSources(input: {
	jobId: string;
	findings: Array<{
		statement: string;
		sourceId: string;
		url: string;
		title: string;
	}>;
}): SynthesisNotes {
	const supportedFindings = input.findings.map((finding) => ({
		kind: "supported" as const,
		statement: finding.statement,
		sourceRefs: [
			{
				reviewedSourceId: finding.sourceId,
				discoveredSourceId: finding.sourceId,
				canonicalUrl: finding.url,
				title: finding.title,
			},
		],
	}));

	return {
		jobId: input.jobId,
		findings: supportedFindings,
		supportedFindings,
		conflicts: [],
		assumptions: [],
		reportLimitations: [],
	};
}

export function standardPassCountForDepth(
	depth?: "focused" | "standard" | "max",
) {
	if (depth === "max") return 5;
	if (depth === "focused") return 2;
	return 3;
}

export async function createApprovedDeepResearchJob(input?: {
	userId?: string;
	conversationId?: string;
	triggerMessageId?: string;
	userRequest?: string;
	depth?: "focused" | "standard" | "max";
	now?: Date;
}): Promise<DeepResearchJob> {
	const {
		userId = deepResearchDefaultUserId,
		conversationId = deepResearchDefaultConversationId,
		triggerMessageId = deepResearchDefaultMessageId,
		userRequest = deepResearchDefaultUserRequest,
		depth = "focused",
		now = new Date("2026-05-05T10:01:00.000Z"),
	} = input ?? {};
	const { approveDeepResearchPlan, startDeepResearchJobShell } = await import(
		"./index"
	);
	const created = await startDeepResearchJobShell({
		userId,
		conversationId,
		triggerMessageId,
		userRequest,
		depth,
		now,
	});
	const approved = await approveDeepResearchPlan({
		userId,
		jobId: created.id,
		now: new Date("2026-05-05T10:06:00.000Z"),
	});
	if (!approved) throw new Error("Expected approval to return the job");
	return approved;
}

export async function completeApprovedJobWithAuditedReport(input?: {
	userId?: string;
	userRequest?: string;
	depth?: "focused" | "standard" | "max";
}) {
	const {
		userId = deepResearchDefaultUserId,
		userRequest = deepResearchDefaultUserRequest,
		depth = "standard",
	} = input ?? {};
	const {
		approveDeepResearchPlan,
		completeDeepResearchJobWithAuditedReport,
		startDeepResearchJobShell,
	} = await import("./index");
	const { markResearchSourceReviewed, saveDiscoveredResearchSource } =
		await import("./sources");

	const created = await startDeepResearchJobShell({
		userId,
		conversationId: deepResearchDefaultConversationId,
		triggerMessageId: deepResearchDefaultMessageId,
		userRequest,
		depth,
		now: new Date("2026-05-05T10:01:00.000Z"),
	});
	await approveDeepResearchPlan({
		userId,
		jobId: created.id,
		now: new Date("2026-05-05T10:06:00.000Z"),
	});
	await seedCompletedMeaningfulPasses(
		created.id,
		standardPassCountForDepth(depth),
		{
			userId,
		},
	);
	const source = await saveDiscoveredResearchSource({
		userId,
		conversationId: deepResearchDefaultConversationId,
		jobId: created.id,
		url: "https://agency.example.test/ai-copyright-training-data",
		title: "Agency AI copyright training data briefing",
		provider: "public_web",
		snippet: "Agency briefing on AI copyright training data rules.",
		discoveredAt: new Date("2026-05-05T10:07:00.000Z"),
	});
	const reviewedSource = await markResearchSourceReviewed({
		userId,
		sourceId: source.id,
		reviewedAt: new Date("2026-05-05T10:08:00.000Z"),
		reviewedNote:
			"EU and US AI copyright training data rules require provenance records and rights-risk review.",
	});
	const synthesisNotes = buildStandardSupportingFinding({
		jobId: created.id,
		sourceId: reviewedSource.id,
		url: reviewedSource.url,
		title: reviewedSource.title ?? "Agency briefing",
	});
	const completed = await completeDeepResearchJobWithAuditedReport({
		userId,
		jobId: created.id,
		synthesisNotes,
		now: new Date("2026-05-05T10:20:00.000Z"),
	});
	return { created, completed, reviewedSourceId: source.id };
}

export async function completeApprovedJobWithEvidenceLimitationMemo(input?: {
	userId?: string;
	userRequest?: string;
	depth?: "focused" | "standard" | "max";
}) {
	const {
		userId = deepResearchDefaultUserId,
		userRequest = "Assess unverified battery recycling claims",
		depth = "focused",
	} = input ?? {};
	const {
		approveDeepResearchPlan,
		completeDeepResearchJobWithEvidenceLimitationMemo,
		startDeepResearchJobShell,
	} = await import("./index");
	const created = await startDeepResearchJobShell({
		userId,
		conversationId: deepResearchDefaultConversationId,
		triggerMessageId: deepResearchDefaultMessageId,
		userRequest,
		depth,
		now: new Date("2026-05-05T10:01:00.000Z"),
	});
	await approveDeepResearchPlan({
		userId,
		jobId: created.id,
		now: new Date("2026-05-05T10:06:00.000Z"),
	});
	const completed = await completeDeepResearchJobWithEvidenceLimitationMemo({
		userId,
		jobId: created.id,
		limitations: ["No useful accepted evidence supported the approved plan."],
		now: new Date("2026-05-05T10:20:00.000Z"),
	});
	return { created, completed };
}
