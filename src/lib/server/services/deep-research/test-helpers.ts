import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "$lib/server/db/schema";
import type { ResearchSource } from "$lib/server/services/web-research";
import type {
	DeepResearchJob,
	DeepResearchPassDecision,
	DeepResearchSource,
} from "$lib/types";
import type {
	DiscoveredResearchSourceCandidate,
	SavedDiscoveredResearchSource,
} from "./discovery";
import type {
	MarkResearchSourceReviewedInput,
	SaveDiscoveredResearchSourceInput,
} from "./sources";
import type { SynthesisNotes } from "./synthesis";
import type { ResearchTimelineEvent } from "./timeline";

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

const deepResearchTestNow = new Date("2026-05-05T10:07:00.000Z");

export const deepResearchDefaultDbPrefix = "alfyai-deep-research";

export const deepResearchDefaultDiscoveredSource = {
	url: "https://agency.example.test/ai-copyright-training-data",
	title: "Agency AI copyright training data briefing",
	provider: "public_web",
	snippet: "Agency briefing on AI copyright training data rules.",
	discoveredAt: deepResearchTestNow,
	reviewedAt: new Date("2026-05-05T10:08:00.000Z"),
	reviewedNote:
		"EU and US AI copyright training data rules require provenance records and rights-risk review.",
};

export function makeResearchSource(
	overrides: Partial<ResearchSource> = {},
): ResearchSource {
	return {
		id: "source-1",
		provider: "searxng",
		title: "Default discovery source",
		url: "https://example.com/default-discovery",
		canonicalUrl: "https://example.com/default-discovery",
		snippet: "A default dependency result.",
		highlights: [],
		text: null,
		score: 1,
		providerRank: 1,
		query: "Compare EU and US AI copyright training data rules",
		publishedAt: null,
		updatedAt: null,
		retrievedAt: "2026-05-05T12:00:00.000Z",
		authorityClass: "standard",
		authorityScore: 55,
		...overrides,
	};
}

export function makeSavedDiscoveredSource(
	source: DiscoveredResearchSourceCandidate,
	index = 1,
): SavedDiscoveredResearchSource {
	return {
		id: `source-${index}`,
		jobId: source.jobId,
		conversationId: source.conversationId,
		userId: source.userId,
		status: "discovered",
		url: source.url,
		title: source.title,
		provider: source.provider,
		snippet: source.metadata.snippet,
		sourceText: source.metadata.text,
		intendedComparedEntity: source.metadata.intendedComparedEntity,
		intendedComparisonAxis: source.metadata.intendedComparisonAxis,
		discoveredAt: source.discoveredAt,
		reviewedAt: null,
		citedAt: null,
		metadata: source.metadata,
	};
}

export function makeSavedDiscoveredSourceFromInput(
	source: SaveDiscoveredResearchSourceInput,
): SavedDiscoveredResearchSource & {
	id: string;
	jobId: string;
	conversationId: string;
	userId: string;
	status: "discovered";
	url: string;
	title: string | null;
	provider: string;
	snippet: string | null;
	sourceText: string | null;
	discoveredAt: string;
	reviewedAt: null;
	citedAt: null;
} {
	const discoveredAt = (source.discoveredAt ?? new Date()).toISOString();
	return {
		id: "source-1",
		jobId: source.jobId,
		conversationId: source.conversationId,
		userId: source.userId,
		status: "discovered",
		url: source.url,
		title: source.title ?? null,
		provider: source.provider,
		snippet: source.snippet ?? null,
		sourceText: source.sourceText ?? null,
		discoveredAt,
		reviewedAt: null,
		citedAt: null,
	};
}

export function mockTimelineEvent(event: ResearchTimelineEvent) {
	return {
		...event,
		id: "event-1",
		createdAt: event.occurredAt,
	};
}

export function createDeepResearchTestDbPath(
	prefix = deepResearchDefaultDbPrefix,
): string {
	return `/tmp/${prefix}-${randomUUID()}.db`;
}

export async function setupDeepResearchTestDb(
	prefix = deepResearchDefaultDbPrefix,
) {
	const dbPath = createDeepResearchTestDbPath(prefix);
	process.env.DATABASE_PATH = dbPath;
	await seedDeepResearchConversation({ dbPath });
	return dbPath;
}

export async function cleanupDeepResearchTestDb(dbPath: string): Promise<void> {
	try {
		const { sqlite } = await import("$lib/server/db");
		sqlite.close();
	} catch {
		// The DB module may not have been imported if a test failed before it was loaded.
	}
	try {
		const { unlinkSync } = await import("node:fs");
		unlinkSync(dbPath);
	} catch {
		// Temporary DB cleanup is best-effort.
	}
}

type SeedReviewOptions = Omit<
	MarkResearchSourceReviewedInput,
	"userId" | "sourceId"
>;

export type SeedDiscoveredSourceInput = SaveDiscoveredResearchSourceInput & {
	reviewed?: SeedReviewOptions;
};

export async function seedDiscoveredSourceWithReview(
	input: SeedDiscoveredSourceInput,
): Promise<{
	source: DeepResearchSource;
	reviewedSource: DeepResearchSource | null;
}> {
	const { saveDiscoveredResearchSource, markResearchSourceReviewed } =
		await import("./sources");
	const { reviewed, ...discovered } = input;
	const source = await saveDiscoveredResearchSource({
		...discovered,
	});
	if (!reviewed) return { source, reviewedSource: null };
	const reviewedSource = await markResearchSourceReviewed({
		userId: discovered.userId,
		sourceId: source.id,
		...reviewed,
	});
	return { source, reviewedSource };
}

export async function seedDefaultReviewedAiCopyrightSource(
	input: Omit<
		SeedDiscoveredSourceInput,
		"url" | "title" | "reviewed" | "provider"
	> & {
		reviewed?: SeedReviewOptions;
		provider?: string;
	},
): Promise<{
	source: DeepResearchSource;
	reviewedSource: DeepResearchSource;
}> {
	const sourceInput: SeedDiscoveredSourceInput = {
		...deepResearchDefaultDiscoveredSource,
		...input,
		provider: input.provider ?? deepResearchDefaultDiscoveredSource.provider,
		reviewed: {
			reviewedAt:
				input.reviewed?.reviewedAt ??
				deepResearchDefaultDiscoveredSource.reviewedAt,
			reviewedNote:
				input.reviewed?.reviewedNote ??
				deepResearchDefaultDiscoveredSource.reviewedNote,
			...input.reviewed,
		},
	};
	const seeded = await seedDiscoveredSourceWithReview(sourceInput);
	if (!seeded.reviewedSource) {
		throw new Error("Expected reviewed source");
	}
	return { source: seeded.source, reviewedSource: seeded.reviewedSource };
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
	meaningfulPassCount?: number;
	meaningfulPassOptions?: Omit<
		Parameters<typeof seedCompletedMeaningfulPasses>[2],
		"userId" | "conversationId"
	>;
}): Promise<DeepResearchJob> {
	const {
		userId = deepResearchDefaultUserId,
		conversationId = deepResearchDefaultConversationId,
		triggerMessageId = deepResearchDefaultMessageId,
		userRequest = deepResearchDefaultUserRequest,
		depth = "focused",
		now = new Date("2026-05-05T10:01:00.000Z"),
		meaningfulPassCount,
		meaningfulPassOptions,
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
	if (meaningfulPassCount) {
		await seedCompletedMeaningfulPasses(created.id, meaningfulPassCount, {
			userId,
			conversationId,
			...meaningfulPassOptions,
		});
	}
	return approved;
}

type ApprovedDeepResearchSourceInput = Omit<
	SeedDiscoveredSourceInput,
	"userId" | "conversationId" | "jobId" | "reviewed"
> & {
	reviewed?: SeedReviewOptions;
};

export async function createApprovedDeepResearchJobWithReviewedSource(input?: {
	userId?: string;
	conversationId?: string;
	triggerMessageId?: string;
	userRequest?: string;
	depth?: "focused" | "standard" | "max";
	now?: Date;
	meaningfulPassCount?: number;
	source?: ApprovedDeepResearchSourceInput;
}): Promise<{
	created: DeepResearchJob;
	source: DeepResearchSource;
	reviewedSource: DeepResearchSource;
}> {
	const {
		userId = deepResearchDefaultUserId,
		conversationId = deepResearchDefaultConversationId,
		triggerMessageId = deepResearchDefaultMessageId,
		userRequest = deepResearchDefaultUserRequest,
		depth = "focused",
		now = new Date("2026-05-05T10:01:00.000Z"),
		meaningfulPassCount = 0,
		source,
	} = input ?? {};
	const created = await createApprovedDeepResearchJob({
		userId,
		conversationId,
		triggerMessageId,
		userRequest,
		depth,
		now,
		meaningfulPassCount,
	});
	const { reviewed, ...sourceOverrides } = source ?? {};
	const seeded = await seedDiscoveredSourceWithReview({
		userId,
		conversationId,
		jobId: created.id,
		...deepResearchDefaultDiscoveredSource,
		...sourceOverrides,
		reviewed: {
			reviewedAt:
				reviewed?.reviewedAt ?? deepResearchDefaultDiscoveredSource.reviewedAt,
			reviewedNote:
				reviewed?.reviewedNote ??
				deepResearchDefaultDiscoveredSource.reviewedNote,
			...reviewed,
		},
	});
	if (!seeded.reviewedSource) {
		throw new Error("Expected reviewed source");
	}
	return {
		created,
		source: seeded.source,
		reviewedSource: seeded.reviewedSource,
	};
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
