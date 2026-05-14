import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

vi.mock("$lib/server/services/deep-research/discovery", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/server/services/deep-research/discovery")>();
	return {
		...actual,
		runPublicWebDiscoveryPass: vi.fn(async (input) => {
			const { saveDiscoveredResearchSource } = await import(
				"$lib/server/services/deep-research/sources"
			);
			const { saveResearchTimelineEvent } = await import(
				"$lib/server/services/deep-research/timeline"
			);
			const now = input.now ?? new Date("2026-05-05T10:07:00.000Z");
			const source = await saveDiscoveredResearchSource({
				jobId: input.jobId,
				conversationId: input.conversationId,
				userId: input.userId,
				url: "https://agency.example.test/ai-copyright-training-data",
				title: "Agency AI copyright training data briefing",
				provider: "public_web",
				snippet: "Agency briefing on AI copyright training data rules.",
				discoveredAt: now,
			});
			await saveResearchTimelineEvent({
				jobId: input.jobId,
				conversationId: input.conversationId,
				userId: input.userId,
				taskId: null,
				stage: "source_discovery",
				kind: "stage_completed",
				occurredAt: now.toISOString(),
				messageKey: "deepResearch.timeline.sourceDiscoveryCompleted",
				messageParams: { discovered: 1 },
				sourceCounts: {
					discovered: 1,
					reviewed: 0,
					cited: 0,
				},
				assumptions: [],
				warnings: [],
				summary: "Public web discovery found 1 candidate source.",
			});
			return {
				queries: [input.approvedPlan.goal],
				discoveredCount: 1,
				savedSources: [source],
				warnings: [],
			};
		}),
	};
});

vi.mock("$lib/server/services/deep-research/planning-context", () => ({
	buildDeepResearchPlanningContext: vi.fn(),
}));

import { buildDeepResearchPlanningContext } from "$lib/server/services/deep-research/planning-context";

let dbPath: string;
let previousDeepResearchEnabled: string | undefined;
const mockBuildDeepResearchPlanningContext = buildDeepResearchPlanningContext as ReturnType<
	typeof vi.fn
>;

const signedInUser = {
	id: "user-1",
	email: "user@example.com",
	displayName: "Test User",
};

async function seedConversation() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });

	const now = new Date("2026-05-05T10:00:00.000Z");
	db.insert(schema.users)
		.values({
			id: signedInUser.id,
			email: signedInUser.email,
			passwordHash: "hash",
		})
		.run();
	db.insert(schema.conversations)
		.values({
			id: "conv-1",
			userId: signedInUser.id,
			title: "Research conversation",
			createdAt: now,
			updatedAt: now,
		})
		.run();

	sqlite.close();
}

async function seedPromptReadyAttachment() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });

	const now = new Date("2026-05-05T10:01:00.000Z");
	db.insert(schema.artifacts)
		.values([
			{
				id: "source-attachment-1",
				userId: signedInUser.id,
				conversationId: "conv-1",
				type: "source_document",
				retrievalClass: "document",
				name: "Uploaded policy memo.pdf",
				mimeType: "application/pdf",
				extension: ".pdf",
				sizeBytes: 2048,
				summary: "Uploaded source memo about AI copyright policy.",
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "normalized-attachment-1",
				userId: signedInUser.id,
				conversationId: "conv-1",
				type: "normalized_document",
				retrievalClass: "document",
				name: "Uploaded policy memo.pdf",
				mimeType: "text/plain",
				extension: ".txt",
				sizeBytes: 4096,
				contentText: "Normalized uploaded policy memo text. ".repeat(100),
				summary: "Normalized prompt-ready memo about AI copyright policy.",
				createdAt: now,
				updatedAt: now,
			},
		])
		.run();
	db.insert(schema.artifactLinks)
		.values({
			id: randomUUID(),
			userId: signedInUser.id,
			artifactId: "normalized-attachment-1",
			relatedArtifactId: "source-attachment-1",
			conversationId: "conv-1",
			linkType: "derived_from",
			createdAt: now,
		})
		.run();

	sqlite.close();
}

function makeJsonEvent(path: string, body?: unknown, params: Record<string, string> = {}) {
	return {
		request: new Request(`http://localhost${path}`, {
			method: "POST",
			headers: body === undefined ? undefined : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
		locals: { user: signedInUser },
		params,
		url: new URL(`http://localhost${path}`),
		route: { id: path },
	} as any;
}

async function readJson(response: Response) {
	return (await response.json()) as Record<string, any>;
}

async function loadConversationStatus(conversationId: string) {
	const { db } = await import("$lib/server/db");
	const [conversation] = await db
		.select({
			id: schema.conversations.id,
			status: schema.conversations.status,
			sealedAt: schema.conversations.sealedAt,
		})
		.from(schema.conversations)
		.where(eq(schema.conversations.id, conversationId));
	return conversation;
}

async function startApproveAndCompleteThroughDevRoutes() {
	const { POST: sendChat } = await import("../chat/send/+server");
	const { POST: approvePlan } = await import("./jobs/[id]/plan/approve/+server");
	const { POST: advanceWorker } = await import("./jobs/[id]/worker/advance/+server");

	const startResponse = await sendChat(
		makeJsonEvent("/api/chat/send", {
			conversationId: "conv-1",
			message: "Compare EU and US AI copyright training data rules",
			deepResearch: { depth: "focused" },
		}),
	);
	const started = await readJson(startResponse);
	const jobId = started.deepResearchJob.id as string;

	const approvalResponse = await approvePlan(
		makeJsonEvent(
			`/api/deep-research/jobs/${jobId}/plan/approve`,
			undefined,
			{ id: jobId },
		),
	);
	const approved = await readJson(approvalResponse);

	const advanceSnapshots: Array<Record<string, any>> = [];
	let completed: Record<string, any> | null = null;
	let completionResponse: Response | null = null;
	const maxAdvances = 12;
	for (let index = 0; index < maxAdvances; index += 1) {
		const response = await advanceWorker(
			makeJsonEvent(
				`/api/deep-research/jobs/${jobId}/worker/advance`,
				undefined,
				{ id: jobId },
			),
		);
		const snapshot = await readJson(response);
		advanceSnapshots.push(snapshot);
		if (response.status !== 200) {
			completionResponse = response;
			completed = snapshot;
			break;
		}
		if (snapshot.job?.status === "completed") {
			completionResponse = response;
			completed = snapshot;
			break;
		}
	}
	const lastSnapshot = advanceSnapshots.at(-1) ?? null;
	expect(
		completed?.job?.status,
		`Expected Deep Research job to complete within ${maxAdvances} worker advances; last response: ${JSON.stringify(lastSnapshot)}`,
	).toBe("completed");
	expect(completionResponse).not.toBeNull();

	return {
		jobId,
		startResponse,
		started,
		approvalResponse,
		approved,
		advanceSnapshots,
		completionResponse: completionResponse as Response,
		completed,
	};
}

describe("Deep Research dev-control acceptance path", () => {
	beforeEach(async () => {
		dbPath = `/tmp/alfyai-deep-research-dev-control-${randomUUID()}.db`;
		previousDeepResearchEnabled = process.env.DEEP_RESEARCH_ENABLED;
		process.env.DEEP_RESEARCH_ENABLED = "true";
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		await seedConversation();
		mockBuildDeepResearchPlanningContext.mockResolvedValue([]);
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// The DB module may not have been imported if a test failed early.
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// Temporary DB cleanup is best-effort.
		}
		if (previousDeepResearchEnabled === undefined) {
			delete process.env.DEEP_RESEARCH_ENABLED;
		} else {
			process.env.DEEP_RESEARCH_ENABLED = previousDeepResearchEnabled;
		}
	});

	it("starts, approves, advances, and completes an evidence limitation memo through public dev routes", async () => {
		const {
			jobId,
			startResponse,
			started,
			approvalResponse,
			approved,
			advanceSnapshots,
			completionResponse,
			completed,
		} = await startApproveAndCompleteThroughDevRoutes();

		expect(startResponse.status).toBe(200);
		expect(started).toMatchObject({
			response: null,
			conversationId: "conv-1",
			deepResearchJob: {
				status: "awaiting_approval",
				stage: "plan_drafted",
				currentPlan: {
					version: 1,
					status: "awaiting_approval",
				},
			},
		});

		expect(approvalResponse.status).toBe(200);
		expect(approved.job).toMatchObject({
			id: jobId,
			status: "approved",
			stage: "plan_approved",
		});

		expect(advanceSnapshots.length).toBeGreaterThan(0);
		expect(advanceSnapshots.some((snapshot) => snapshot.advanced)).toBe(true);
		expect(advanceSnapshots.every((snapshot) => snapshot.job?.id === jobId)).toBe(
			true,
		);
		expect(
			advanceSnapshots.some(
				(snapshot) =>
					snapshot.outcome === "discovery_completed" ||
					snapshot.job?.stage === "source_review",
			),
		).toBe(true);
		const sourceConversation = await loadConversationStatus("conv-1");

		expect(completionResponse.status).toBe(200);
		expect(completed).toMatchObject({
			advanced: true,
			job: {
				id: jobId,
				status: "completed",
				stage: "evidence_limitation_memo_ready",
				reportArtifactId: expect.any(String),
			},
		});
		expect(sourceConversation).toMatchObject({
			id: "conv-1",
			status: "open",
			sealedAt: null,
		});
	});

	it("discloses attached planning context and persists it as approved Research Sources", async () => {
		await seedPromptReadyAttachment();
		mockBuildDeepResearchPlanningContext.mockResolvedValueOnce([
			{
				type: "attachment",
				artifactId: "normalized-attachment-1",
				title: "Uploaded policy memo.pdf",
				summary: "Normalized prompt-ready memo about AI copyright policy.",
				includeAsResearchSource: true,
			},
		]);

		const { POST: sendChat } = await import("../chat/send/+server");
		const { POST: approvePlan } = await import("./jobs/[id]/plan/approve/+server");
		const { listResearchSources } = await import("$lib/server/services/deep-research/sources");

		const startResponse = await sendChat(
			makeJsonEvent("/api/chat/send", {
				conversationId: "conv-1",
				message: "  Compare EU and US AI copyright training data rules using my memo.  ",
				attachmentIds: ["source-attachment-1"],
				activeDocumentArtifactId: "active-document-1",
				deepResearch: { depth: "focused" },
			}),
		);
		const started = await readJson(startResponse);
		const jobId = started.deepResearchJob.id as string;
		const renderedPlan = started.deepResearchJob.currentPlan.renderedPlan as string;

		expect(startResponse.status).toBe(200);
		expect(mockBuildDeepResearchPlanningContext).toHaveBeenCalledWith({
			userId: signedInUser.id,
			conversationId: "conv-1",
			userRequest: "Compare EU and US AI copyright training data rules using my memo.",
			attachmentIds: ["source-attachment-1"],
			activeDocumentArtifactId: "active-document-1",
		});
		expect(renderedPlan).toContain("Context considered: 1 attachment item.");
		expect(renderedPlan).toContain("Uploaded policy memo.pdf");

		const approvalResponse = await approvePlan(
			makeJsonEvent(
				`/api/deep-research/jobs/${jobId}/plan/approve`,
				undefined,
				{ id: jobId },
			),
		);
		const sources = await listResearchSources({
			userId: signedInUser.id,
			jobId,
		});

		expect(approvalResponse.status).toBe(200);
		expect(sources).toEqual([
			expect.objectContaining({
				jobId,
				conversationId: "conv-1",
				status: "discovered",
				url: "artifact:normalized-attachment-1",
				title: "Uploaded policy memo.pdf",
				provider: "attached_file",
			}),
		]);
	});

	it("keeps the completed memo source conversation open while Report Actions create new conversations", async () => {
		const { POST: discussReport } = await import(
			"./jobs/[id]/report-actions/discuss/+server"
		);
		const { POST: researchFurther } = await import(
			"./jobs/[id]/report-actions/research-further/+server"
		);
		const { jobId, completed } = await startApproveAndCompleteThroughDevRoutes();
		const reportArtifactId = completed.job.reportArtifactId as string;

		const discussResponse = await discussReport(
			makeJsonEvent(
				`/api/deep-research/jobs/${jobId}/report-actions/discuss`,
				undefined,
				{ id: jobId },
			),
		);
		const discuss = await readJson(discussResponse);
		const researchFurtherResponse = await researchFurther(
			makeJsonEvent(
				`/api/deep-research/jobs/${jobId}/report-actions/research-further`,
				{ depth: "standard" },
				{ id: jobId },
			),
		);
		const further = await readJson(researchFurtherResponse);

		const sourceConversation = await loadConversationStatus("conv-1");
		const discussConversation = await loadConversationStatus(
			discuss.conversation.id as string,
		);
		const furtherConversation = await loadConversationStatus(
			further.conversation.id as string,
		);

		expect(discussResponse.status).toBe(201);
		expect(discuss).toMatchObject({
			sourceJobId: jobId,
			reportArtifactId,
			conversation: {
				title: "Discuss: Compare EU and US AI copyright training data rules",
			},
		});
		expect(researchFurtherResponse.status).toBe(201);
		expect(further).toMatchObject({
			sourceJobId: jobId,
			reportArtifactId,
			conversation: {
				title: "Research further: Compare EU and US AI copyright training data rules",
			},
			messageId: expect.any(String),
			job: {
				status: "awaiting_approval",
				stage: "plan_drafted",
				depth: "standard",
			},
		});
		expect(discuss.conversation.id).not.toBe("conv-1");
		expect(further.conversation.id).not.toBe("conv-1");
		expect(further.conversation.id).not.toBe(discuss.conversation.id);
		expect(sourceConversation).toMatchObject({
			id: "conv-1",
			status: "open",
			sealedAt: null,
		});
		expect(discussConversation).toMatchObject({
			id: discuss.conversation.id,
			status: "open",
			sealedAt: null,
		});
		expect(furtherConversation).toMatchObject({
			id: further.conversation.id,
			status: "open",
			sealedAt: null,
		});
	});
});
