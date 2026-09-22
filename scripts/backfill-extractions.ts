#!/usr/bin/env tsx
/**
 * Knowledge-library backfill: re-extracts every existing MinerU-routed
 * document through MinerU 4, so documents parsed under MinerU 3.x (flat text,
 * no page numbers, no outline) get pages, an outline and structured chunks.
 *
 * Reuses the exact "Re-extract at a higher tier" path a user gets from the
 * Knowledge list row action — `materializeLegacyExtractionJob` +
 * `requeueExtractionJobForReextraction` in
 * `src/lib/server/services/extraction/{job-ledger,reextract}.ts` — so a
 * document this script touches goes through the identical replace path: same
 * CAS-guarded ledger transaction, same worker, same
 * `createNormalizedArtifactFromExtraction` (persist.ts) that rewrites the
 * normalized artifact IN PLACE (keeping its id) and leaves the SOURCE
 * document's id/title/created_at/conversation links untouched. Old chunks and
 * content stay exactly as they are until the new parse succeeds — a failed or
 * skipped document is never touched beyond its ledger row. See docs/uploads.md
 * for the full explanation and the exact prod command.
 *
 * ── Scope ───────────────────────────────────────────────────────────────
 * Every `artifacts` row of type `source_document` (the ONE table that holds
 * both knowledge-page uploads and chat-attachment documents — they differ
 * only by `conversation_id` being set; the extraction ledger and the shared
 * file-type registry treat them identically, so both are in scope here)
 * whose current registry route (`getIntakeRoute`) is `mineru` and whose
 * `storage_path` resolves to a file that still exists on disk
 * (`resolveDeletablePath`, the same containment helper the delete/sweep paths
 * use — never used here to delete anything, only to check existence safely).
 *
 * `direct-text` documents are skipped by default. `--include-direct-text`
 * re-runs them through the CURRENT chunker (local CPU, no MinerU round trip —
 * cheap and safe, and exactly what D3 of the Phase 3 ledger spec already
 * allows: direct-text goes through the same ledger and is awaited inline for
 * a bounded budget). Idempotency for them cannot be tier-based (direct-text
 * has no tier), so it is `requested_by`-based instead: skip a direct-text
 * document that already has a `succeeded` job this script itself created.
 *
 * `reject`-route types (formats the registry no longer accepts at all) are
 * listed as "unsupported now" and always skipped — nothing this script can do
 * makes an unsupported format supported.
 *
 * ── Tier and idempotency ────────────────────────────────────────────────
 * `--tier` defaults to the configured `MINERU_DEFAULT_TIER` (resolved to the
 * server's best offered tier if that is `auto`). A registry `tierHint` of
 * "flash" (every Office, HTML, RTF, EPUB format) still wins per document,
 * exactly as the live extractor's own `decideTier` documents ("Office/HTML/
 * CSV/EPUB inputs execute at flash anyway") — but the CLIENT sends whatever
 * tier the hint override carries, so this script computes the effective
 * per-document tier itself and requests `flash` outright for those types,
 * rather than requesting a tier they can never reach and re-enqueueing them
 * forever.
 *
 * A document is skipped as "already done" when it has a `succeeded` job whose
 * normalized artifact's `extractionTier` already ranks at or above the
 * document's own effective requested tier (`mineruTierRank`) — UNCONDITIONAL
 * on `--since`, on purpose: a document that is already at the right quality
 * should never be re-touched, whoever produced that parse and whenever they
 * did it. `--since` instead scopes `--status` and `--only-failed` to "this
 * script's own campaign": it defaults to the `created_at` of the earliest job
 * row this script has ever stamped `requested_by = 'backfill'` (the schema
 * has no column that already fit; migration
 * `1777140000100_document_extraction_jobs_requested_by.sql` added one,
 * deliberately never cleared by `completeExtractionAttempt` the way
 * `hints_json` is, so it survives success).
 *
 * A document already carrying a queued/active job is always skipped ("already
 * in flight") regardless of tier or `--since`.
 *
 * ── Fairness ────────────────────────────────────────────────────────────
 * This script enqueues every eligible document up front, in one pass, rather
 * than throttling in rounds. `claimNextExtractionJob`
 * (src/lib/server/services/extraction/job-ledger.ts, the `headIds` query) already
 * claims "one row PER USER — that user's oldest claimable job" before it ever
 * looks at priority or age, so flooding the queue with one user's whole
 * library cannot starve any other user's claim; the worker's own fairness
 * absorbs it. This script bypasses the five-in-flight-per-user re-extraction
 * cap (`MAX_ACTIVE_REEXTRACTIONS_PER_USER`) via
 * `requeueExtractionJobForReextraction`'s own `maxActiveReextractions`
 * override — the same seam the function already exposes "for tests", used
 * here for its intended purpose: a system-initiated bulk operation.
 *
 * ── Usage ───────────────────────────────────────────────────────────────
 *   DATABASE_PATH=./data/chat.db npx tsx scripts/backfill-extractions.ts
 *   DATABASE_PATH=./data/chat.db npx tsx scripts/backfill-extractions.ts --apply
 *   DATABASE_PATH=./data/chat.db npx tsx scripts/backfill-extractions.ts --status
 *
 * Flags: --apply, --tier <flash|basic|standard|advanced>, --include-direct-text,
 * --since <iso>, --limit N, --user <id|email>, --only-failed, --status.
 *
 * `--dry-run` is the DEFAULT: with no `--apply`, nothing is written.
 */
import { config as dotenvConfig } from "dotenv";

dotenvConfig();

import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, inArray, sql } from "drizzle-orm";

// ── CLI args ────────────────────────────────────────────────────────────

export interface BackfillArgs {
	apply: boolean;
	tier: string | null;
	includeDirectText: boolean;
	since: Date | null;
	limit: number | null;
	user: string | null;
	onlyFailed: boolean;
	status: boolean;
}

function readFlagValue(argv: string[], flag: string): string | null {
	const eqPrefix = `${flag}=`;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === flag) return argv[i + 1] ?? null;
		if (arg?.startsWith(eqPrefix)) return arg.slice(eqPrefix.length);
	}
	return null;
}

export function parseArgs(argv: string[]): BackfillArgs {
	const limitRaw = readFlagValue(argv, "--limit");
	const sinceRaw = readFlagValue(argv, "--since");
	let since: Date | null = null;
	if (sinceRaw) {
		const parsed = new Date(sinceRaw);
		if (Number.isNaN(parsed.getTime())) {
			throw new Error(`--since is not a valid ISO date: "${sinceRaw}"`);
		}
		since = parsed;
	}
	return {
		apply: argv.includes("--apply"),
		tier: readFlagValue(argv, "--tier"),
		includeDirectText: argv.includes("--include-direct-text"),
		since,
		limit: limitRaw ? Number(limitRaw) : null,
		user: readFlagValue(argv, "--user"),
		onlyFailed: argv.includes("--only-failed"),
		status: argv.includes("--status"),
	};
}

// ── The plan ────────────────────────────────────────────────────────────

export type SkipReason =
	| "route_reject"
	| "route_direct_text_excluded"
	| "missing_file"
	| "in_flight"
	| "already_at_tier"
	| "already_backfilled";

export interface CandidateDocument {
	artifactId: string;
	userId: string;
	fileName: string;
	mimeType: string | null;
	sizeBytes: number;
	storagePath: string | null;
	createdAt: Date;
	conversationId: string | null;
}

export interface PlanItem {
	doc: CandidateDocument;
	/** "vision"/"archive" are reserved registry routes with no entries yet (see
	 * `src/lib/shared/file-types/types.ts`); treated identically to "reject"
	 * below — unsupported today, never enqueued. */
	route: "mineru" | "direct-text" | "reject" | "vision" | "archive";
	rejectReason?: string;
	include: boolean;
	skipReason?: SkipReason;
	effectiveTier: string | null;
	tierForced: boolean;
	currentTier: string | null;
	jobStatus: string | null;
	jobId: string | null;
	legacy: boolean;
}

export interface BackfillPlan {
	tier: string;
	since: Date;
	items: PlanItem[];
}

export interface ApplyOutcome {
	artifactId: string;
	userId: string;
	ok: boolean;
	reason?: string;
}

export interface ApplyResult {
	enqueued: ApplyOutcome[];
	failed: ApplyOutcome[];
}

type Deps = Awaited<ReturnType<typeof loadDeps>>;

async function loadDeps() {
	const [
		dbModule,
		schema,
		fileTypes,
		mineruConfig,
		capabilities,
		jobLedger,
		reextract,
		storageContainment,
	] = await Promise.all([
		import("$lib/server/db"),
		import("$lib/server/db/schema"),
		import("$lib/shared/file-types"),
		import("$lib/server/services/mineru/config"),
		import("$lib/server/services/mineru/capabilities"),
		import("$lib/server/services/extraction/job-ledger"),
		import("$lib/server/services/extraction/reextract"),
		import("$lib/server/storage-containment"),
	]);
	return {
		db: dbModule.db,
		schema,
		fileTypes,
		mineruConfig,
		capabilities,
		jobLedger,
		reextract,
		storageContainment,
	};
}

/** `MINERU_DEFAULT_TIER`, resolved to a concrete tier if it is `auto`. */
async function resolveDefaultTier(deps: Deps): Promise<string> {
	const config = deps.mineruConfig.resolveMineruConfig();
	if (config.defaultTier !== "auto") return config.defaultTier;
	const caps = await deps.capabilities.getMineruCapabilities();
	const best = [...caps.tiers].sort(
		(a, b) =>
			deps.mineruConfig.mineruTierRank(b) - deps.mineruConfig.mineruTierRank(a),
	)[0];
	if (!best) {
		throw new Error(
			"MINERU_DEFAULT_TIER=auto and MinerU reports no tiers; pass --tier explicitly.",
		);
	}
	return best;
}

async function resolveUserFilter(
	deps: Deps,
	userArg: string | null,
): Promise<string | null> {
	if (!userArg) return null;
	if (!userArg.includes("@")) return userArg;
	const [row] = await deps.db
		.select({ id: deps.schema.users.id })
		.from(deps.schema.users)
		.where(eq(deps.schema.users.email, userArg))
		.limit(1);
	if (!row) throw new Error(`No user with email ${userArg}`);
	return row.id;
}

/** The `created_at` of the earliest job this script has ever stamped. */
async function resolveDefaultSince(deps: Deps): Promise<Date> {
	const [row] = await deps.db
		.select({
			min: sql<
				number | null
			>`min(${deps.schema.documentExtractionJobs.createdAt})`,
		})
		.from(deps.schema.documentExtractionJobs)
		.where(eq(deps.schema.documentExtractionJobs.requestedBy, "backfill"));
	if (!row?.min) return new Date(0);
	return new Date(row.min * 1000);
}

async function resolveFileExists(
	deps: Deps,
	storagePath: string | null,
): Promise<boolean> {
	if (!storagePath) return false;
	const resolved =
		await deps.storageContainment.resolveDeletablePath(storagePath);
	if (!resolved) return false;
	try {
		const { stat } = await import("node:fs/promises");
		const info = await stat(resolved);
		return info.isFile();
	} catch {
		return false;
	}
}

/**
 * Builds the full plan: every `source_document` artifact, classified as
 * include-and-enqueue or skip-with-a-reason. Read-only — never writes.
 */
export async function buildBackfillPlan(
	args: BackfillArgs,
): Promise<BackfillPlan> {
	const deps = await loadDeps();
	const cliTier = args.tier ?? (await resolveDefaultTier(deps));
	const since = args.since ?? (await resolveDefaultSince(deps));
	const userId = await resolveUserFilter(deps, args.user);

	const rows = await deps.db
		.select({
			id: deps.schema.artifacts.id,
			userId: deps.schema.artifacts.userId,
			name: deps.schema.artifacts.name,
			mimeType: deps.schema.artifacts.mimeType,
			sizeBytes: deps.schema.artifacts.sizeBytes,
			storagePath: deps.schema.artifacts.storagePath,
			createdAt: deps.schema.artifacts.createdAt,
			conversationId: deps.schema.artifacts.conversationId,
		})
		.from(deps.schema.artifacts)
		.where(
			and(
				eq(deps.schema.artifacts.type, "source_document"),
				userId ? eq(deps.schema.artifacts.userId, userId) : undefined,
			),
		);

	const items: PlanItem[] = [];

	for (const row of rows) {
		const doc: CandidateDocument = {
			artifactId: row.id,
			userId: row.userId,
			fileName: row.name,
			mimeType: row.mimeType,
			sizeBytes: row.sizeBytes ?? 0,
			storagePath: row.storagePath,
			createdAt: row.createdAt,
			conversationId: row.conversationId,
		};

		const route = deps.fileTypes.getIntakeRoute(doc.fileName, doc.mimeType);

		if (route !== "mineru" && route !== "direct-text") {
			// "reject", or a reserved route no entry uses yet — either way,
			// unsupported today.
			const entry = deps.fileTypes.resolveEntry(doc.fileName, doc.mimeType);
			items.push({
				doc,
				route,
				rejectReason: entry?.intake.rejectReason ?? "unknownType",
				include: false,
				skipReason: "route_reject",
				effectiveTier: null,
				tierForced: false,
				currentTier: null,
				jobStatus: null,
				jobId: null,
				legacy: true,
			});
			continue;
		}

		if (route === "direct-text" && !args.includeDirectText) {
			items.push({
				doc,
				route: "direct-text",
				include: false,
				skipReason: "route_direct_text_excluded",
				effectiveTier: null,
				tierForced: false,
				currentTier: null,
				jobStatus: null,
				jobId: null,
				legacy: true,
			});
			continue;
		}

		const [jobRow] = await deps.db
			.select()
			.from(deps.schema.documentExtractionJobs)
			.where(
				eq(deps.schema.documentExtractionJobs.sourceArtifactId, doc.artifactId),
			)
			.limit(1);
		const legacy = !jobRow;
		const jobStatus = jobRow?.status ?? null;

		const tierHint = deps.fileTypes.getIntakeTierHint(
			doc.fileName,
			doc.mimeType,
		);
		const effectiveTier =
			route === "mineru" ? (tierHint === "flash" ? "flash" : cliTier) : null;
		const tierForced = tierHint === "flash";

		// In flight: never touch it.
		if (
			jobRow &&
			!["succeeded", "failed", "canceled"].includes(jobRow.status)
		) {
			items.push({
				doc,
				route,
				include: false,
				skipReason: "in_flight",
				effectiveTier,
				tierForced,
				currentTier: null,
				jobStatus,
				jobId: jobRow.id,
				legacy,
			});
			continue;
		}

		if (
			route === "mineru" &&
			jobRow?.status === "succeeded" &&
			jobRow.normalizedArtifactId
		) {
			const [normalized] = await deps.db
				.select({ metadataJson: deps.schema.artifacts.metadataJson })
				.from(deps.schema.artifacts)
				.where(eq(deps.schema.artifacts.id, jobRow.normalizedArtifactId))
				.limit(1);
			let currentTier: string | null = null;
			if (normalized?.metadataJson) {
				try {
					const meta = JSON.parse(normalized.metadataJson) as Record<
						string,
						unknown
					>;
					currentTier =
						typeof meta.extractionTier === "string"
							? meta.extractionTier
							: null;
				} catch {
					currentTier = null;
				}
			}
			const achievedRank = deps.mineruConfig.mineruTierRank(currentTier);
			const requestedRank = deps.mineruConfig.mineruTierRank(effectiveTier);
			if (achievedRank >= requestedRank) {
				items.push({
					doc,
					route,
					include: false,
					skipReason: "already_at_tier",
					effectiveTier,
					tierForced,
					currentTier,
					jobStatus,
					jobId: jobRow.id,
					legacy,
				});
				continue;
			}
			items.push({
				doc,
				route,
				include: true,
				effectiveTier,
				tierForced,
				currentTier,
				jobStatus,
				jobId: jobRow.id,
				legacy,
			});
			continue;
		}

		// Direct-text idempotency: requested_by-based, not tier-based (no tier
		// concept applies). Skip only a document THIS script already finished.
		if (
			route === "direct-text" &&
			jobRow?.status === "succeeded" &&
			jobRow.requestedBy === "backfill"
		) {
			items.push({
				doc,
				route,
				include: false,
				skipReason: "already_backfilled",
				effectiveTier,
				tierForced,
				currentTier: null,
				jobStatus,
				jobId: jobRow.id,
				legacy,
			});
			continue;
		}

		const fileExists = await resolveFileExists(deps, doc.storagePath);
		if (!fileExists) {
			items.push({
				doc,
				route,
				include: false,
				skipReason: "missing_file",
				effectiveTier,
				tierForced,
				currentTier: null,
				jobStatus,
				jobId: jobRow?.id ?? null,
				legacy,
			});
			continue;
		}

		items.push({
			doc,
			route,
			include: true,
			effectiveTier,
			tierForced,
			currentTier: null,
			jobStatus,
			jobId: jobRow?.id ?? null,
			legacy,
		});
	}

	return { tier: cliTier, since, items };
}

/**
 * Narrows an already-built plan to `--only-failed`: documents whose most
 * recent job was THIS script's own (`requested_by = 'backfill'`), is
 * terminal `failed`, and is user-retryable.
 */
export function filterOnlyFailed(
	plan: BackfillPlan,
	backfillJobsById: Map<
		string,
		{ requestedBy: string | null; status: string; retryable: boolean }
	>,
): PlanItem[] {
	return plan.items.filter((item) => {
		if (!item.jobId) return false;
		const job = backfillJobsById.get(item.jobId);
		if (!job) return false;
		return (
			job.requestedBy === "backfill" && job.status === "failed" && job.retryable
		);
	});
}

// ── Apply ───────────────────────────────────────────────────────────────

export async function applyBackfillPlan(
	items: PlanItem[],
	options: { limit: number | null },
): Promise<ApplyResult> {
	const deps = await loadDeps();
	const toApply = options.limit != null ? items.slice(0, options.limit) : items;

	const enqueued: ApplyOutcome[] = [];
	const failed: ApplyOutcome[] = [];

	for (const item of toApply) {
		if (!item.include || !item.effectiveTier) continue;
		try {
			let jobId = item.jobId;
			if (item.legacy || !jobId) {
				const materialized =
					await deps.jobLedger.materializeLegacyExtractionJob({
						userId: item.doc.userId,
						sourceArtifactId: item.doc.artifactId,
						fileName: item.doc.fileName,
						mimeType: item.doc.mimeType,
						sizeBytes: item.doc.sizeBytes,
						conversationId: item.doc.conversationId,
					});
				if (!materialized) {
					failed.push({
						artifactId: item.doc.artifactId,
						userId: item.doc.userId,
						ok: false,
						reason: "materialize_failed",
					});
					continue;
				}
				jobId = materialized.id;
			}

			const requeued = await deps.reextract.requeueExtractionJobForReextraction(
				{
					userId: item.doc.userId,
					jobId,
					hints:
						item.route === "mineru" && item.effectiveTier
							? { tier: item.effectiveTier }
							: null,
					// System-initiated: the five-in-flight-per-user re-extraction cap
					// exists to stop a USER from self-inflicting an outage; it must not
					// stop an operator's own deliberate, one-time bulk backfill.
					maxActiveReextractions: Number.MAX_SAFE_INTEGER,
				},
			);

			if (!requeued.ok) {
				failed.push({
					artifactId: item.doc.artifactId,
					userId: item.doc.userId,
					ok: false,
					reason: requeued.reason,
				});
				continue;
			}

			await deps.db
				.update(deps.schema.documentExtractionJobs)
				.set({ requestedBy: "backfill" })
				.where(eq(deps.schema.documentExtractionJobs.id, jobId));

			enqueued.push({
				artifactId: item.doc.artifactId,
				userId: item.doc.userId,
				ok: true,
			});
		} catch (error) {
			failed.push({
				artifactId: item.doc.artifactId,
				userId: item.doc.userId,
				ok: false,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}

	if (enqueued.length > 0) {
		const worker = await import(
			"$lib/server/services/extraction/worker-runner"
		);
		worker.wakeExtractionWorker();
	}

	return { enqueued, failed };
}

// ── Status ──────────────────────────────────────────────────────────────

export interface StatusReport {
	byStatus: Record<string, number>;
	byTier: Record<string, number>;
	failedDocuments: Array<{
		artifactId: string;
		fileName: string;
		errorCode: string | null;
		retryable: boolean;
	}>;
}

export async function buildStatusReport(
	since: Date | null,
): Promise<StatusReport> {
	const deps = await loadDeps();
	const effectiveSince = since ?? (await resolveDefaultSince(deps));

	const rows = await deps.db
		.select()
		.from(deps.schema.documentExtractionJobs)
		.where(
			and(
				eq(deps.schema.documentExtractionJobs.requestedBy, "backfill"),
				sql`${deps.schema.documentExtractionJobs.createdAt} >= ${Math.floor(effectiveSince.getTime() / 1000)}`,
			),
		);

	const byStatus: Record<string, number> = {};
	const byTier: Record<string, number> = {};
	const failedDocuments: StatusReport["failedDocuments"] = [];

	const normalizedIds = rows
		.filter((row) => row.status === "succeeded" && row.normalizedArtifactId)
		.map((row) => row.normalizedArtifactId as string);
	const normalizedById = new Map<string, string | null>();
	if (normalizedIds.length > 0) {
		const normalizedRows = await deps.db
			.select({
				id: deps.schema.artifacts.id,
				metadataJson: deps.schema.artifacts.metadataJson,
			})
			.from(deps.schema.artifacts)
			.where(inArray(deps.schema.artifacts.id, normalizedIds));
		for (const row of normalizedRows) {
			let tier: string | null = null;
			if (row.metadataJson) {
				try {
					const meta = JSON.parse(row.metadataJson) as Record<string, unknown>;
					tier =
						typeof meta.extractionTier === "string"
							? meta.extractionTier
							: null;
				} catch {
					tier = null;
				}
			}
			normalizedById.set(row.id, tier);
		}
	}

	for (const row of rows) {
		byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
		if (row.status === "succeeded") {
			const tier = row.normalizedArtifactId
				? normalizedById.get(row.normalizedArtifactId)
				: null;
			const key = tier ?? "unknown";
			byTier[key] = (byTier[key] ?? 0) + 1;
		}
		if (row.status === "failed") {
			failedDocuments.push({
				artifactId: row.sourceArtifactId ?? row.id,
				fileName: row.fileName,
				errorCode: row.errorCode,
				retryable: row.retryable,
			});
		}
	}

	return { byStatus, byTier, failedDocuments };
}

// ── Reporting ───────────────────────────────────────────────────────────

function printDryRunReport(plan: BackfillPlan, limit: number | null): void {
	const included = plan.items.filter((item) => item.include);
	const excluded = plan.items.filter((item) => !item.include);
	const toEnqueue = limit != null ? included.slice(0, limit) : included;

	console.log(`Tier:          ${plan.tier}`);
	console.log(`Since default: ${plan.since.toISOString()}`);
	console.log(`Eligible:      ${included.length} document(s)`);
	if (limit != null && included.length > limit) {
		console.log(
			`  (--limit ${limit}: this run would enqueue ${toEnqueue.length} of them)`,
		);
	}

	const byRoute = new Map<string, number>();
	const byUser = new Map<string, number>();
	let totalBytes = 0;
	for (const item of toEnqueue) {
		byRoute.set(item.route, (byRoute.get(item.route) ?? 0) + 1);
		byUser.set(item.doc.userId, (byUser.get(item.doc.userId) ?? 0) + 1);
		totalBytes += item.doc.sizeBytes;
	}
	console.log("\nPer intake route (documents this run would enqueue):");
	for (const [route, count] of byRoute) console.log(`  ${route}  ${count}`);
	console.log("\nPer user:");
	for (const [userId, count] of [...byUser].sort((a, b) => b[1] - a[1])) {
		console.log(`  ${userId}  ${count}`);
	}
	console.log(`\nTotal bytes: ${totalBytes}`);

	console.log("\nExclusions:");
	const byReason = new Map<string, number>();
	for (const item of excluded) {
		const reason = item.skipReason ?? "unknown";
		byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
	}
	for (const [reason, count] of byReason) console.log(`  ${reason}  ${count}`);

	const rejectByReason = new Map<string, number>();
	for (const item of excluded) {
		if (item.route === "reject") {
			const key = item.rejectReason ?? "unknownType";
			rejectByReason.set(key, (rejectByReason.get(key) ?? 0) + 1);
		}
	}
	if (rejectByReason.size > 0) {
		console.log("\nUnsupported now (reject route):");
		for (const [reason, count] of rejectByReason)
			console.log(`  ${reason}  ${count}`);
	}

	if (limit == null) {
		console.log(
			"\nDry run — nothing was enqueued. Re-run with --apply to enqueue these.",
		);
	} else {
		console.log(
			`\nDry run — nothing was enqueued. Re-run with --apply --limit ${limit} for a first careful batch.`,
		);
	}
}

function printStatusReport(report: StatusReport): void {
	console.log(
		"Backfill progress (from the ledger, requested_by = 'backfill'):\n",
	);
	console.log("By status:");
	for (const [status, count] of Object.entries(report.byStatus)) {
		console.log(`  ${status}  ${count}`);
	}
	if (Object.keys(report.byTier).length > 0) {
		console.log("\nSucceeded, by achieved tier:");
		for (const [tier, count] of Object.entries(report.byTier)) {
			console.log(`  ${tier}  ${count}`);
		}
	}
	if (report.failedDocuments.length > 0) {
		console.log("\nFailed documents:");
		for (const doc of report.failedDocuments) {
			const autoRetry =
				"no (auto-retry already exhausted before reaching 'failed')";
			const manual = doc.retryable
				? "yes — re-run with --only-failed, or Retry in the UI"
				: "no — terminal; the source bytes cannot become readable, re-upload instead";
			console.log(
				`  ${doc.artifactId}  ${doc.fileName}  error=${doc.errorCode ?? "unknown"}  auto-retry: ${autoRetry}  manual retry: ${manual}`,
			);
		}
	}
}

// ── main ────────────────────────────────────────────────────────────────

export async function main(argv: string[]): Promise<number> {
	if (!process.env.DATABASE_PATH?.trim()) {
		console.error(
			"ERROR: DATABASE_PATH must be set explicitly, e.g.\n" +
				"  DATABASE_PATH=./data/chat.db npx tsx scripts/backfill-extractions.ts",
		);
		return 1;
	}

	const args = parseArgs(argv);

	if (args.status) {
		const report = await buildStatusReport(args.since);
		printStatusReport(report);
		return 0;
	}

	if (args.onlyFailed) {
		const plan = await buildBackfillPlan(args);
		const deps = await loadDeps();
		const jobIds = plan.items
			.map((item) => item.jobId)
			.filter((id): id is string => Boolean(id));
		const jobRows =
			jobIds.length > 0
				? await deps.db
						.select()
						.from(deps.schema.documentExtractionJobs)
						.where(inArray(deps.schema.documentExtractionJobs.id, jobIds))
				: [];
		const byId = new Map(
			jobRows.map((row) => [
				row.id,
				{
					requestedBy: row.requestedBy,
					status: row.status,
					retryable: row.retryable,
				},
			]),
		);
		const items = filterOnlyFailed(plan, byId).map((item) => ({
			...item,
			include: true,
		}));
		console.log(
			`--only-failed: ${items.length} document(s) with a user-retryable backfill failure.`,
		);
		if (!args.apply) {
			for (const item of items.slice(0, args.limit ?? items.length)) {
				console.log(`  ${item.doc.artifactId}  ${item.doc.fileName}`);
			}
			console.log(
				"\nDry run — nothing was enqueued. Re-run with --apply to re-enqueue these.",
			);
			return 0;
		}
		const result = await applyBackfillPlan(items, { limit: args.limit });
		printApplySummary(result);
		return result.failed.length > 0 ? 1 : 0;
	}

	const plan = await buildBackfillPlan(args);

	if (!args.apply) {
		printDryRunReport(plan, args.limit);
		return 0;
	}

	const toApply = plan.items.filter((item) => item.include);
	const result = await applyBackfillPlan(toApply, { limit: args.limit });
	printApplySummary(result);
	return result.failed.length > 0 ? 1 : 0;
}

function printApplySummary(result: ApplyResult): void {
	console.log(`\nEnqueued ${result.enqueued.length} document(s).`);
	if (result.failed.length > 0) {
		console.log(
			`${result.failed.length} document(s) could NOT be enqueued (left untouched):`,
		);
		for (const failure of result.failed) {
			console.log(`  ${failure.artifactId}  ${failure.reason}`);
		}
	}
}

function isDirectExecution(): boolean {
	return Boolean(
		process.argv[1] &&
			resolvePath(process.argv[1]) === fileURLToPath(import.meta.url),
	);
}

if (isDirectExecution()) {
	main(process.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((error) => {
			console.error(error);
			process.exit(1);
		});
}
