import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;

async function seedDeepResearchJob() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });

	const now = new Date("2026-05-05T10:00:00.000Z");
	db.insert(schema.users)
		.values({
			id: "user-1",
			email: "user@example.com",
			passwordHash: "hash",
		})
		.run();
	db.insert(schema.conversations)
		.values({
			id: "conversation-1",
			userId: "user-1",
			title: "Research conversation",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.deepResearchJobs)
		.values({
			id: "job-1",
			userId: "user-1",
			conversationId: "conversation-1",
			depth: "standard",
			status: "running",
			stage: "source_review",
			title: "Compare EU and US AI copyright training data rules",
			userRequest: "Compare EU and US AI copyright training data rules",
			createdAt: now,
			updatedAt: now,
		})
		.run();

	sqlite.close();
}

describe("deep research pass state", () => {
	beforeEach(async () => {
		dbPath = `/tmp/alfyai-research-pass-state-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		await seedDeepResearchJob();
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
	});

	it("persists a weak first pass checkpoint with durable Coverage Gaps", async () => {
		const {
			completeResearchPassCheckpoint,
			listResearchCoverageGaps,
			listResearchPassCheckpoints,
			saveCoverageGapsForPass,
			upsertResearchPassCheckpoint,
		} = await import("./pass-state");

		const checkpoint = await upsertResearchPassCheckpoint({
			userId: "user-1",
			jobId: "job-1",
			conversationId: "conversation-1",
			passNumber: 1,
			searchIntent: "Initial approved-plan source review",
			reviewedSourceIds: [],
			coverageResult: {
				status: "insufficient",
				reviewedSourceCount: 0,
			},
			now: new Date("2026-05-05T10:10:00.000Z"),
		});
		const gaps = await saveCoverageGapsForPass({
			userId: "user-1",
			jobId: "job-1",
			conversationId: "conversation-1",
			passCheckpointId: checkpoint.id,
			gaps: [
				{
					keyQuestion: "How does EU law treat AI training data?",
					reason: "insufficient_reviewed_sources",
					reviewedSourceCount: 0,
					severity: "critical",
					recommendedNextAction: "Review additional EU regulator sources.",
				},
				{
					keyQuestion: "Which US litigation is still unresolved?",
					reason: "stale_evidence",
					reviewedSourceCount: 0,
					severity: "important",
					recommendedNextAction: "Find fresher US court docket coverage.",
					comparisonAxis: "jurisdiction",
				},
			],
			now: new Date("2026-05-05T10:11:00.000Z"),
		});
		await completeResearchPassCheckpoint({
			userId: "user-1",
			checkpointId: checkpoint.id,
			coverageGapIds: gaps.map((gap) => gap.id),
			nextDecision: "continue_research",
			decisionSummary:
				"Continue with targeted follow-up work for 2 unresolved Coverage Gaps.",
			now: new Date("2026-05-05T10:12:00.000Z"),
		});

		const checkpoints = await listResearchPassCheckpoints({
			userId: "user-1",
			jobId: "job-1",
		});
		const persistedGaps = await listResearchCoverageGaps({
			userId: "user-1",
			jobId: "job-1",
		});

		expect(checkpoints).toEqual([
			expect.objectContaining({
				id: checkpoint.id,
				passNumber: 1,
				searchIntent: "Initial approved-plan source review",
				reviewedSourceIds: [],
				coverageGapIds: gaps.map((gap) => gap.id),
				nextDecision: "continue_research",
				decisionSummary:
					"Continue with targeted follow-up work for 2 unresolved Coverage Gaps.",
				terminalDecision: true,
				completedAt: "2026-05-05T10:12:00.000Z",
			}),
		]);
		expect(persistedGaps).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: gaps[0].id,
					passCheckpointId: checkpoint.id,
					lifecycleState: "open",
					severity: "critical",
					keyQuestion: "How does EU law treat AI training data?",
					recommendedNextAction: "Review additional EU regulator sources.",
				}),
				expect.objectContaining({
					id: gaps[1].id,
					lifecycleState: "open",
					severity: "important",
					comparisonAxis: "jurisdiction",
					recommendedNextAction: "Find fresher US court docket coverage.",
				}),
			]),
		);
	});

	it("keeps terminal pass decisions immutable", async () => {
		const {
			ResearchPassCheckpointImmutableError,
			completeResearchPassCheckpoint,
			upsertResearchPassCheckpoint,
		} = await import("./pass-state");

		const checkpoint = await upsertResearchPassCheckpoint({
			userId: "user-1",
			jobId: "job-1",
			conversationId: "conversation-1",
			passNumber: 1,
			searchIntent: "Initial approved-plan source review",
			reviewedSourceIds: [],
			coverageResult: {
				status: "insufficient",
				reviewedSourceCount: 0,
			},
			now: new Date("2026-05-05T10:10:00.000Z"),
		});
		await completeResearchPassCheckpoint({
			userId: "user-1",
			checkpointId: checkpoint.id,
			nextDecision: "publish_evidence_limitation_memo",
			decisionSummary:
				"Publish a memo because no reviewed evidence is available.",
			now: new Date("2026-05-05T10:12:00.000Z"),
		});

		await expect(
			upsertResearchPassCheckpoint({
				userId: "user-1",
				jobId: "job-1",
				conversationId: "conversation-1",
				passNumber: 1,
				searchIntent: "Rewrite decided pass",
				reviewedSourceIds: ["late-source"],
				coverageResult: {
					status: "sufficient",
					reviewedSourceCount: 1,
				},
				now: new Date("2026-05-05T10:13:00.000Z"),
			}),
		).rejects.toBeInstanceOf(ResearchPassCheckpointImmutableError);
	});

	it("keeps resolved Coverage Gaps inspectable with resolution links", async () => {
		const {
			completeResearchPassCheckpoint,
			listResearchCoverageGaps,
			resolveResearchCoverageGaps,
			saveCoverageGapsForPass,
			upsertResearchPassCheckpoint,
		} = await import("./pass-state");

		const checkpoint = await upsertResearchPassCheckpoint({
			userId: "user-1",
			jobId: "job-1",
			conversationId: "conversation-1",
			passNumber: 1,
			searchIntent: "Initial approved-plan source review",
			now: new Date("2026-05-05T10:10:00.000Z"),
		});
		const [gap] = await saveCoverageGapsForPass({
			userId: "user-1",
			jobId: "job-1",
			conversationId: "conversation-1",
			passCheckpointId: checkpoint.id,
			gaps: [
				{
					keyQuestion: "Which source is authoritative?",
					reason: "unresolved_conflict",
					reviewedSourceCount: 2,
					severity: "critical",
					recommendedNextAction: "Resolve conflicting source claims.",
				},
			],
			now: new Date("2026-05-05T10:11:00.000Z"),
		});
		await completeResearchPassCheckpoint({
			userId: "user-1",
			checkpointId: checkpoint.id,
			coverageGapIds: [gap.id],
			nextDecision: "continue_research",
			decisionSummary: "Continue to resolve one conflict gap.",
			now: new Date("2026-05-05T10:12:00.000Z"),
		});

		await resolveResearchCoverageGaps({
			userId: "user-1",
			gapIds: [gap.id],
			lifecycleState: "resolved",
			resolutionSummary: "Resolved by targeted task evidence.",
			resolvedByEvidence: {
				taskIds: ["task-1"],
				sourceIds: ["source-1"],
			},
			now: new Date("2026-05-05T10:20:00.000Z"),
		});

		const [resolvedGap] = await listResearchCoverageGaps({
			userId: "user-1",
			jobId: "job-1",
		});

		expect(resolvedGap).toMatchObject({
			id: gap.id,
			lifecycleState: "resolved",
			resolutionSummary: "Resolved by targeted task evidence.",
			resolvedByEvidence: {
				taskIds: ["task-1"],
				sourceIds: ["source-1"],
			},
			resolvedAt: "2026-05-05T10:20:00.000Z",
		});
	});
});
