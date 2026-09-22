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
 * script's own campaign", measured in `updated_at` — the column a requeue and
 * a completion actually move, unlike `created_at`, which for every document
 * that already had a ledger row is the day it was UPLOADED. It defaults to the
 * earliest `updated_at` among the job rows this script has ever stamped
 * `requested_by = 'backfill'` (the schema had no column that fit; migration
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
 *   DATABASE_PATH=./data/chat.db npx tsx scripts/backfill-extractions.ts \
 *     --verify data/backfill-snapshots/<stamp>.json
 *
 * Flags: --apply, --tier <flash|basic|standard|advanced>, --include-direct-text,
 * --since <iso>, --limit N, --user <id|email>, --only-failed, --status,
 * --verify <snapshot>, --shrink-threshold <0..1>.
 *
 * `--dry-run` is the DEFAULT: with no `--apply`, nothing is written.
 *
 * ── The shrink check ────────────────────────────────────────────────────
 * The replace path is safe against a parse that returns NOTHING (the result
 * parser raises `empty_result`, which never reaches `persist.ts`). It is not
 * safe against a parse that returns a tenth of the text: that succeeds, and
 * `rewriteNormalizedArtifact` replaces the old content with it. Nothing in
 * the ledger can tell those apart from a good parse.
 *
 * So `--apply` writes `data/backfill-snapshots/<stamp>.json` BEFORE it
 * enqueues anything — every document in the batch, with the text length and
 * chunk count it had at that moment — and prints the path. Afterwards,
 * `--verify <that file>` compares every SUCCEEDED document against it and
 * lists the ones that came back below `--shrink-threshold` (default 0.5) of
 * their old size, with old/new sizes, the account and the file name.
 *
 * It is a report. Nothing is re-queued, repaired or deleted on a shrink, and
 * `--verify` always exits 0 — the operator opens the listed documents and
 * decides. The snapshot lives OUTSIDE `data/knowledge/`, so none of the
 * storage-cleanup paths can reach it.
 */
import { config as dotenvConfig } from "dotenv";

dotenvConfig();

import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

// ── CLI args ────────────────────────────────────────────────────────────

/**
 * A refusal the operator caused and can fix: a bad flag, an unserved tier, an
 * unreachable backend on an `--apply`. `main` prints it as one line and exits
 * 1, rather than as a stack — a stack trace out of an operations script reads
 * as "the script is broken", which sends an operator looking in entirely the
 * wrong place on the one night they are least able to afford it.
 */
export class BackfillUsageError extends Error {
	override readonly name = "BackfillUsageError";
}

export interface BackfillArgs {
	apply: boolean;
	tier: string | null;
	includeDirectText: boolean;
	since: Date | null;
	limit: number | null;
	user: string | null;
	onlyFailed: boolean;
	status: boolean;
	/** Path to a snapshot written by an earlier `--apply`. */
	verify: string | null;
	/** The remaining fraction below which a document counts as shrunk. */
	shrinkThreshold: number;
}

/**
 * How much of a document's text may survive a re-parse before it is worth
 * looking at by hand.
 *
 * 0.5 means "flag anything that came back smaller than half its old size".
 * The pipeline already refuses a parse that produced NOTHING — the MinerU
 * result parser raises `empty_result`, which is terminal and non-retryable —
 * so the gap this covers is the one nothing else can see: a parse that
 * succeeds and returns a fraction of the text, which replaces the old content
 * and reports `succeeded`. Over a whole library nobody would notice by
 * reading; over a snapshot it is one line.
 */
export const DEFAULT_SHRINK_THRESHOLD = 0.5;

function readFlagValue(argv: string[], flag: string): string | null {
	const eqPrefix = `${flag}=`;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === flag) return argv[i + 1] ?? null;
		if (arg?.startsWith(eqPrefix)) return arg.slice(eqPrefix.length);
	}
	return null;
}

/**
 * The four tier ids, restated as a plain literal so `parseArgs` stays a pure
 * function with no `$lib` import — the CLI must be able to refuse a typo
 * before it opens a database or probes a backend. Kept honest by a test that
 * compares it against `MINERU_TIER_IDS`.
 */
export const BACKFILL_TIER_IDS = [
	"flash",
	"basic",
	"standard",
	"advanced",
] as const;

export function parseArgs(argv: string[]): BackfillArgs {
	const limitRaw = readFlagValue(argv, "--limit");
	const sinceRaw = readFlagValue(argv, "--since");
	let since: Date | null = null;
	if (sinceRaw) {
		const parsed = new Date(sinceRaw);
		if (Number.isNaN(parsed.getTime())) {
			throw new BackfillUsageError(
				`--since is not a valid ISO date: "${sinceRaw}"`,
			);
		}
		since = parsed;
	}

	// A typo'd tier used to be accepted in silence and then do two wrong things
	// at once: `mineruTierRank` ranks an unknown string at -1, so EVERY already
	// parsed document outranked it and was skipped as "already at tier", while
	// the documents that did get enqueued carried a `tier` hint the extractor's
	// own `readHintedTier` rejects — so they were parsed at the server's default
	// instead. For a once-only run over a whole production library, that is a
	// silent wrong answer dressed up as a clean one.
	const tier = readFlagValue(argv, "--tier");
	if (
		tier !== null &&
		!(BACKFILL_TIER_IDS as readonly string[]).includes(tier)
	) {
		throw new BackfillUsageError(
			`--tier must be one of ${BACKFILL_TIER_IDS.join(", ")}; got "${tier}"`,
		);
	}

	// `Number("abc")` is NaN, and `items.slice(0, NaN)` is the empty array: an
	// unparseable --limit used to enqueue nothing and report "Enqueued 0
	// document(s)", which reads exactly like a finished library.
	let limit: number | null = null;
	if (limitRaw !== null) {
		const parsed = Number(limitRaw);
		if (!Number.isInteger(parsed) || parsed < 1) {
			throw new BackfillUsageError(
				`--limit must be a positive integer; got "${limitRaw}"`,
			);
		}
		limit = parsed;
	}

	const thresholdRaw = readFlagValue(argv, "--shrink-threshold");
	let shrinkThreshold = DEFAULT_SHRINK_THRESHOLD;
	if (thresholdRaw !== null) {
		const parsed = Number(thresholdRaw);
		// `> 0` and `<= 1`: zero would flag nothing at all (no document can be
		// smaller than none of itself), and above one would flag every document
		// that did not grow, which is a report nobody would read twice.
		if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
			throw new BackfillUsageError(
				`--shrink-threshold must be a fraction in (0, 1]; got "${thresholdRaw}"`,
			);
		}
		shrinkThreshold = parsed;
	}

	const verify = readFlagValue(argv, "--verify");
	if (verify !== null && verify.trim().length === 0) {
		throw new BackfillUsageError("--verify needs the path of a snapshot file");
	}

	return {
		apply: argv.includes("--apply"),
		tier,
		includeDirectText: argv.includes("--include-direct-text"),
		verify,
		shrinkThreshold,
		since,
		limit,
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
	/**
	 * The MinerU endpoint this run resolved to, AFTER the `admin_config`
	 * overlay. Printed, because the whole class of bug it belongs to — the
	 * script talking to a different backend than the app — is invisible unless
	 * somebody says which one out loud. The API key is never printed.
	 */
	mineruApiUrl: string;
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
	/** Where the pre-backfill snapshot went, for `--verify`. */
	snapshotPath: string | null;
}

type Deps = Awaited<ReturnType<typeof loadDeps>>;

/**
 * Overlays `admin_config` onto the env-derived defaults, exactly as the server
 * does on its first request.
 *
 * `getConfig()` returns whatever `buildDefaultConfig()` made out of the
 * PROCESS ENVIRONMENT until somebody calls `refreshConfig()`; the running app
 * calls it once from `ensureRuntimeConfigReady` in `src/hooks.server.ts`. A
 * script that skips it is not reading the deployment's configuration at all —
 * it is reading `.env`.
 *
 * That is not academic. On the dev box, `shared/.env` says
 * `MINERU_API_URL=http://127.0.0.1:8001` and the `admin_config` row the app
 * actually runs on says `http://127.0.0.1:8002`, so the dry run probed a
 * backend nobody uses and reported it unreachable. Every MinerU key is
 * admin-overridable — the URL, the API key, `MINERU_DEFAULT_TIER`, the
 * timeouts — so without this the tier this script requests and the endpoint it
 * verifies against can both be wrong, in a way that looks exactly like a
 * working script.
 *
 * Done once per process, after the database is open (it reads `admin_config`)
 * and before anything asks for a MinerU setting.
 */
let configOverlay: Promise<void> | null = null;

async function ensureAdminConfigOverlay(): Promise<void> {
	configOverlay ??= (async () => {
		const { refreshConfig } = await import("$lib/server/config-store");
		await refreshConfig();
	})().catch((error) => {
		// Do not cache a failure: a transient SQLITE_BUSY on the first read
		// should not leave the whole run on env-only configuration in silence.
		configOverlay = null;
		throw error;
	});
	await configOverlay;
}

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
	// After the imports (the db module opens the file on import) and before any
	// caller can read a MinerU or extraction setting off `getConfig()`.
	await ensureAdminConfigOverlay();
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
		throw new BackfillUsageError(
			"MINERU_DEFAULT_TIER=auto and MinerU reports no tiers; pass --tier explicitly.",
		);
	}
	return best;
}

/**
 * The tier every `mineru` document in this run is requested at, checked
 * against the tiers the backend actually serves.
 *
 * The Re-extract endpoint refuses an unserved tier before it writes a single
 * ledger row, and says why: "A tier MinerU does not serve is a 400
 * `invalid_request` from the backend three seconds into an attempt, i.e. a
 * failed job and a wasted attempt for a mistake that was knowable up front."
 * That argument is a thousand times stronger for a whole-library backfill,
 * which would otherwise mark an entire production library `failed` — with the
 * old content intact, but with every document's attempt budget spent and an
 * operator with a thousand red rows to sort out.
 *
 * A dry run still works with MinerU down: planning before the cutover is a
 * legitimate thing to do, and it writes nothing. `--apply` does not.
 */
async function resolveRequestedTier(
	deps: Deps,
	args: BackfillArgs,
): Promise<string> {
	const tier = args.tier ?? (await resolveDefaultTier(deps));

	let offered: readonly string[] | null = null;
	try {
		offered = (await deps.capabilities.getMineruCapabilities()).tiers;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		if (args.apply) {
			throw new BackfillUsageError(
				`MinerU is unreachable, so tier "${tier}" could not be verified before enqueueing: ${detail}\n` +
					"Fix the backend first, or re-run without --apply to plan offline.",
			);
		}
		console.warn(
			`WARNING: MinerU is unreachable, so tier "${tier}" was NOT verified (${detail}).\n` +
				"         --apply will refuse until the backend answers.",
		);
	}

	if (offered && !offered.includes(tier)) {
		throw new BackfillUsageError(
			`MinerU does not serve tier "${tier}". It serves: ${offered.join(", ") || "(none)"}.`,
		);
	}

	return tier;
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
	if (!row) throw new BackfillUsageError(`No user with email ${userArg}`);
	return row.id;
}

/**
 * When this script's campaign started, measured in `updated_at`.
 *
 * NOT `created_at`. A job row's `created_at` is when the DOCUMENT was first
 * enqueued, which for everything except the legacy rows this script
 * materialises itself is the day the user uploaded the file — often years
 * before the backfill. Windowing on it made `--since <cutover>` report only
 * the handful of freshly materialised rows and silently omit every document
 * that already had a ledger row, i.e. most of the library. `updated_at` is
 * written by the requeue and by every completion, so it is the column that
 * actually moves when this campaign touches a job.
 */
async function resolveDefaultSince(deps: Deps): Promise<Date> {
	const [row] = await deps.db
		.select({
			min: sql<
				number | null
			>`min(${deps.schema.documentExtractionJobs.updatedAt})`,
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
	const cliTier = await resolveRequestedTier(deps, args);
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
		)
		// Ordered so a run is reproducible. Without it SQLite is free to return
		// rows in whatever order the plan it picked happens to produce, which made
		// "--limit 20, look at the result, then run the rest" an inspection of an
		// arbitrary twenty — and, since the artifact table is clustered by
		// insertion, in practice the twenty oldest documents of whichever account
		// joined first.
		.orderBy(
			asc(deps.schema.artifacts.createdAt),
			asc(deps.schema.artifacts.id),
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

	return {
		tier: cliTier,
		since,
		mineruApiUrl: deps.mineruConfig.resolveMineruConfig().baseUrl,
		items,
	};
}

/**
 * Narrows an already-built plan to `--only-failed`: documents whose most
 * recent job was THIS script's own (`requested_by = 'backfill'`), is
 * terminal `failed`, is user-retryable, and whose failure falls inside the
 * `--since` window.
 *
 * The skip reasons matter here as much as the job status. A plan item can
 * carry a retryable failed job AND be excluded — a document whose file is gone
 * from disk is the common one — and re-enqueueing that only spends another
 * attempt to arrive at the same `internal` failure. Only `already_at_tier`,
 * which cannot co-exist with `failed`, and the include-able items are eligible.
 */
const ONLY_FAILED_INELIGIBLE_SKIPS: ReadonlySet<SkipReason> = new Set([
	"missing_file",
	"in_flight",
	"route_reject",
	"route_direct_text_excluded",
]);

export function filterOnlyFailed(
	plan: BackfillPlan,
	backfillJobsById: Map<
		string,
		{
			requestedBy: string | null;
			status: string;
			retryable: boolean;
			updatedAt?: Date | null;
		}
	>,
	since?: Date | null,
): PlanItem[] {
	return plan.items.filter((item) => {
		if (!item.jobId) return false;
		if (item.skipReason && ONLY_FAILED_INELIGIBLE_SKIPS.has(item.skipReason)) {
			return false;
		}
		const job = backfillJobsById.get(item.jobId);
		if (!job) return false;
		if (
			!(
				job.requestedBy === "backfill" &&
				job.status === "failed" &&
				job.retryable
			)
		) {
			return false;
		}
		// `--since` is documented to scope `--only-failed` to one campaign; it
		// used to be parsed, printed and then ignored here.
		if (since && job.updatedAt && job.updatedAt.getTime() < since.getTime()) {
			return false;
		}
		return true;
	});
}

// ── The pre-backfill snapshot ───────────────────────────────────────────

/**
 * Where snapshots go: `data/backfill-snapshots/`.
 *
 * Deliberately a SIBLING of `data/knowledge`, never inside it. Everything
 * under `data/knowledge/<userId>/` belongs to a user and is reachable by the
 * orphan sweep, by bundle eviction and by "Forget all results" — all of which
 * resolve paths through `storageRoots()` (`src/lib/server/storage-containment.ts`),
 * whose two roots are `data/knowledge` and `data/chat-files`. A safety record
 * that the cleanup paths can delete is not a safety record, and one filed
 * under one user's directory would also be deleted with that user.
 */
export const BACKFILL_SNAPSHOT_DIR = ["data", "backfill-snapshots"] as const;

export interface SnapshotEntry {
	userId: string;
	fileName: string;
	/** null when the document had no normalized artifact yet — nothing to lose. */
	normalizedArtifactId: string | null;
	/** Characters of `content_text`, measured in SQL so nothing is loaded. */
	contentLength: number | null;
	chunkCount: number | null;
}

export interface BackfillSnapshot {
	version: 1;
	createdAt: string;
	tier: string | null;
	/** source_artifact_id → what that document looked like BEFORE the backfill. */
	documents: Record<string, SnapshotEntry>;
}

/** `2026-09-22T15-30-00-123Z` — an ISO instant a filename can hold. */
function snapshotStamp(now: Date): string {
	return now.toISOString().replace(/[:.]/g, "-");
}

/**
 * What every document in this batch looks like right now.
 *
 * Read BEFORE a single job is requeued, and written to disk before the apply
 * loop starts rather than after it: a run that is interrupted half way is
 * exactly the run whose "before" values nobody can reconstruct afterwards.
 * Entries for documents the loop then refuses are harmless — the comparison
 * only ever looks at documents that went on to succeed.
 */
export async function captureBackfillSnapshot(
	items: PlanItem[],
	options: { tier?: string | null; now?: Date } = {},
): Promise<BackfillSnapshot> {
	const deps = await loadDeps();
	const documents: Record<string, SnapshotEntry> = {};

	for (const item of items) {
		const [link] = await deps.db
			.select({ id: deps.schema.artifacts.id })
			.from(deps.schema.artifactLinks)
			.innerJoin(
				deps.schema.artifacts,
				eq(deps.schema.artifactLinks.artifactId, deps.schema.artifacts.id),
			)
			.where(
				and(
					eq(deps.schema.artifactLinks.userId, item.doc.userId),
					eq(deps.schema.artifactLinks.relatedArtifactId, item.doc.artifactId),
					eq(deps.schema.artifactLinks.linkType, "derived_from"),
					eq(deps.schema.artifacts.type, "normalized_document"),
				),
			)
			// The same "oldest link wins" rule `getNormalizedArtifactForSource`
			// uses, so the snapshot measures the artifact the prompt pipeline
			// actually reads and the re-extraction actually rewrites.
			.orderBy(asc(deps.schema.artifactLinks.createdAt))
			.limit(1);

		if (!link) {
			documents[item.doc.artifactId] = {
				userId: item.doc.userId,
				fileName: item.doc.fileName,
				normalizedArtifactId: null,
				contentLength: null,
				chunkCount: null,
			};
			continue;
		}

		const [sizes] = await deps.db
			.select({
				// `length()` in SQL, not `text.length` in JS: a library's worth of
				// multi-megabyte markdown does not need to travel through this
				// process to be counted.
				contentLength: sql<number>`coalesce(length(${deps.schema.artifacts.contentText}), 0)`,
			})
			.from(deps.schema.artifacts)
			.where(eq(deps.schema.artifacts.id, link.id))
			.limit(1);

		const [chunks] = await deps.db
			.select({ count: sql<number>`count(*)` })
			.from(deps.schema.artifactChunks)
			.where(eq(deps.schema.artifactChunks.artifactId, link.id));

		documents[item.doc.artifactId] = {
			userId: item.doc.userId,
			fileName: item.doc.fileName,
			normalizedArtifactId: link.id,
			contentLength: sizes?.contentLength ?? 0,
			chunkCount: chunks?.count ?? 0,
		};
	}

	return {
		version: 1,
		createdAt: (options.now ?? new Date()).toISOString(),
		tier: options.tier ?? null,
		documents,
	};
}

/** Writes the snapshot and returns the path it went to. */
export async function writeBackfillSnapshot(
	snapshot: BackfillSnapshot,
	options: { now?: Date } = {},
): Promise<string> {
	const { mkdir, writeFile } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const dir = join(process.cwd(), ...BACKFILL_SNAPSHOT_DIR);
	await mkdir(dir, { recursive: true });
	const path = join(dir, `${snapshotStamp(options.now ?? new Date())}.json`);
	await writeFile(path, JSON.stringify(snapshot, null, 2), "utf8");
	return path;
}

export async function readBackfillSnapshot(
	path: string,
): Promise<BackfillSnapshot> {
	const { readFile } = await import("node:fs/promises");
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		throw new BackfillUsageError(
			`No snapshot file at ${path}\n` +
				`       (--apply prints the path of the one it wrote; they live in ${BACKFILL_SNAPSHOT_DIR.join("/")}/)`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new BackfillUsageError(`${path} is not valid JSON`);
	}
	const snapshot = parsed as Partial<BackfillSnapshot>;
	if (
		!snapshot ||
		snapshot.version !== 1 ||
		typeof snapshot.documents !== "object" ||
		snapshot.documents === null
	) {
		throw new BackfillUsageError(
			`${path} is not a backfill snapshot (expected {"version": 1, "documents": {...}})`,
		);
	}
	return snapshot as BackfillSnapshot;
}

// ── Apply ───────────────────────────────────────────────────────────────

/**
 * The first `limit` documents to touch, sampled ACROSS accounts rather than
 * taken off the front of one.
 *
 * `--limit` exists to make a first batch you can look at before committing the
 * library. A flat `slice` gave you one account's twenty oldest files, which
 * answers "does this work for that account's 2019 PDFs" and nothing else; a
 * round robin over users answers "does this work for my library", which is the
 * question the flag is for. Order within each account stays the plan's, so the
 * batch is still reproducible.
 */
export function selectLimitedBatch(
	items: PlanItem[],
	limit: number | null,
): PlanItem[] {
	if (limit == null || items.length <= limit) return items;

	const byUser = new Map<string, PlanItem[]>();
	for (const item of items) {
		const queue = byUser.get(item.doc.userId);
		if (queue) queue.push(item);
		else byUser.set(item.doc.userId, [item]);
	}

	const queues = [...byUser.values()];
	const picked: PlanItem[] = [];
	let tookOne = true;
	while (picked.length < limit && tookOne) {
		tookOne = false;
		for (const queue of queues) {
			if (picked.length >= limit) break;
			const next = queue.shift();
			if (!next) continue;
			picked.push(next);
			tookOne = true;
		}
	}
	return picked;
}

export async function applyBackfillPlan(
	items: PlanItem[],
	options: {
		limit: number | null;
		/** The tier recorded in the snapshot, for the operator's own records. */
		tier?: string | null;
		/** Set false only by a caller that has already written its own. */
		snapshot?: boolean;
		now?: Date;
	},
): Promise<ApplyResult> {
	const deps = await loadDeps();
	const toApply = selectLimitedBatch(items, options.limit);

	// Before anything is requeued: what every document in this batch looks like
	// now. A re-extraction REPLACES text and chunks, and the pipeline's only
	// guard is `empty_result` — a parse that comes back with a tenth of the
	// text succeeds and overwrites. This file is what makes that visible
	// afterwards, and it has to exist before the first job moves.
	let snapshotPath: string | null = null;
	if (options.snapshot !== false && toApply.some((item) => item.include)) {
		const snapshot = await captureBackfillSnapshot(
			toApply.filter((item) => item.include),
			{
				tier: options.tier ?? null,
				...(options.now ? { now: options.now } : {}),
			},
		);
		snapshotPath = await writeBackfillSnapshot(
			snapshot,
			options.now ? { now: options.now } : {},
		);
		console.log(`Pre-backfill snapshot: ${snapshotPath}`);
		console.log(
			`  (${Object.keys(snapshot.documents).length} document(s); check them afterwards with --verify ${snapshotPath})`,
		);
	}

	const enqueued: ApplyOutcome[] = [];
	const failed: ApplyOutcome[] = [];

	for (const item of toApply) {
		if (!item.include) continue;
		// A `mineru` document with no effective tier is a bug in the plan, not a
		// document to skip quietly: `continue` here used to swallow EVERY
		// `direct-text` item too (they have no tier by construction), so
		// `--include-direct-text --apply` enqueued nothing at all and still printed
		// "Enqueued 0" as if there had been nothing to do.
		if (item.route === "mineru" && !item.effectiveTier) {
			failed.push({
				artifactId: item.doc.artifactId,
				userId: item.doc.userId,
				ok: false,
				reason: "no_effective_tier",
			});
			continue;
		}
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

			// Stamped BEFORE the requeue, not after.
			//
			// The stamp and the requeue are two transactions either way, and the
			// order decides what a Ctrl-C (or a crash) between them leaves behind.
			// Stamping second left a window where a job was `queued` for the worker
			// but invisible to `--status` and to `--only-failed` — a document this
			// script had genuinely started, which no later run of this script could
			// ever see as its own. Stamping first means the only thing a crash can
			// leave is a row labelled ours that we did not requeue, and the `include`
			// classification above already had to be true for us to be here, so a
			// resumed run reaches exactly the same verdict for it.
			const [previous] = await deps.db
				.select({ requestedBy: deps.schema.documentExtractionJobs.requestedBy })
				.from(deps.schema.documentExtractionJobs)
				.where(eq(deps.schema.documentExtractionJobs.id, jobId))
				.limit(1);
			await deps.db
				.update(deps.schema.documentExtractionJobs)
				.set({ requestedBy: "backfill" })
				.where(eq(deps.schema.documentExtractionJobs.id, jobId));

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
				// Refused, so this row is not ours after all: put back whatever it
				// said before, or a `user_limit`/`attempt_ceiling` refusal would
				// relabel somebody's organic upload as part of this campaign.
				await deps.db
					.update(deps.schema.documentExtractionJobs)
					.set({ requestedBy: previous?.requestedBy ?? null })
					.where(eq(deps.schema.documentExtractionJobs.id, jobId));
				failed.push({
					artifactId: item.doc.artifactId,
					userId: item.doc.userId,
					ok: false,
					reason: requeued.reason,
				});
				continue;
			}

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

	// Deliberately NOT waking the worker from here.
	//
	// That function is in-process: it starts a drain in whatever process calls
	// it. It cannot reach the SERVER's worker, which is the one that has to run
	// this queue — and calling it here turned this short-lived CLI into a second
	// extraction worker that claimed jobs against the live database and was then
	// killed by `process.exit` a few milliseconds later, mid-attempt, leaving
	// rows in `uploading`/`parsing` for the server's stale sweep to reclaim.
	// Nothing is lost that way, but a MinerU backend that serves one job at a
	// time gets a competing claimant for no reason.
	//
	// Nothing needs waking: the server's scheduler idle-ticks every 5–60 s
	// (`IDLE_TICK_MIN_MS`/`IDLE_TICK_MAX_MS` in worker-runner.ts) and claims
	// whatever is queued, so the backfill starts draining within a minute.

	return { enqueued, failed, snapshotPath };
}

// ── Status ──────────────────────────────────────────────────────────────

/**
 * How many ids to bind in one `IN (...)`. Well under SQLite's compiled
 * `SQLITE_MAX_VARIABLE_NUMBER`, and small enough that the query plan stays
 * boring on a library with tens of thousands of documents.
 */
const SQL_VARIABLE_CHUNK = 500;

function chunked<T>(values: readonly T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < values.length; i += size) {
		chunks.push(values.slice(i, i + size));
	}
	return chunks;
}

export interface ShrunkDocument {
	artifactId: string;
	userId: string;
	fileName: string;
	beforeLength: number;
	afterLength: number;
	beforeChunks: number;
	afterChunks: number;
	/** What is LEFT, as a fraction: 0.12 means the new text is 12% of the old. */
	remainingFraction: number;
}

export interface StatusReport {
	byStatus: Record<string, number>;
	byTier: Record<string, number>;
	failedDocuments: Array<{
		artifactId: string;
		fileName: string;
		errorCode: string | null;
		retryable: boolean;
	}>;
	/**
	 * Present only when a snapshot was supplied. `shrunk` is the report the
	 * whole snapshot exists for; `comparedAgainst` and `compared` are there so
	 * an empty `shrunk` can be read as "nothing shrank" rather than as "nothing
	 * was checked", which are very different answers.
	 */
	comparedAgainst?: string;
	compared?: number;
	shrunk?: ShrunkDocument[];
}

/**
 * Every document the snapshot recorded that came back smaller than
 * `threshold` of its old self.
 *
 * Text length and chunk count are both checked, and either one is enough to
 * flag: a parse can keep most of the characters and collapse the structure
 * that made them findable, and a chunk table that went from 300 rows to 4 is
 * a retrieval regression whether or not the markdown survived.
 *
 * Nothing is repaired, requeued or deleted here. It is a list to look at.
 */
export function findShrunkDocuments(
	snapshot: BackfillSnapshot,
	after: Map<string, { contentLength: number; chunkCount: number }>,
	threshold: number,
): ShrunkDocument[] {
	const shrunk: ShrunkDocument[] = [];
	for (const [artifactId, before] of Object.entries(snapshot.documents)) {
		const now = after.get(artifactId);
		if (!now) continue;
		// No baseline: the document had no normalized artifact before, so the
		// backfill gave it text rather than replacing any. Nothing can have been
		// lost, and dividing by zero would flag every one of them.
		if (!before.normalizedArtifactId) continue;
		const beforeLength = before.contentLength ?? 0;
		const beforeChunks = before.chunkCount ?? 0;
		if (beforeLength <= 0 && beforeChunks <= 0) continue;

		const textFraction =
			beforeLength > 0 ? now.contentLength / beforeLength : 1;
		const chunkFraction = beforeChunks > 0 ? now.chunkCount / beforeChunks : 1;
		const remainingFraction = Math.min(textFraction, chunkFraction);
		if (remainingFraction >= threshold) continue;

		shrunk.push({
			artifactId,
			userId: before.userId,
			fileName: before.fileName,
			beforeLength,
			afterLength: now.contentLength,
			beforeChunks,
			afterChunks: now.chunkCount,
			remainingFraction,
		});
	}
	// Worst first: the operator reads the top of this list and stops.
	return shrunk.sort((a, b) => a.remainingFraction - b.remainingFraction);
}

export async function buildStatusReport(
	since: Date | null,
	options: { snapshot?: BackfillSnapshot; shrinkThreshold?: number } = {},
): Promise<StatusReport> {
	const deps = await loadDeps();
	const effectiveSince = since ?? (await resolveDefaultSince(deps));

	const rows = await deps.db
		.select()
		.from(deps.schema.documentExtractionJobs)
		.where(
			and(
				eq(deps.schema.documentExtractionJobs.requestedBy, "backfill"),
				// `updated_at`, not `created_at` — see `resolveDefaultSince`.
				sql`${deps.schema.documentExtractionJobs.updatedAt} >= ${Math.floor(effectiveSince.getTime() / 1000)}`,
			),
		);

	const byStatus: Record<string, number> = {};
	const byTier: Record<string, number> = {};
	const failedDocuments: StatusReport["failedDocuments"] = [];

	const normalizedIds = rows
		.filter((row) => row.status === "succeeded" && row.normalizedArtifactId)
		.map((row) => row.normalizedArtifactId as string);
	const normalizedById = new Map<string, string | null>();
	// Chunked: `inArray` binds one SQLite variable per id, and a whole-library
	// campaign can hand this list every succeeded document on the box.
	for (const idChunk of chunked(normalizedIds, SQL_VARIABLE_CHUNK)) {
		const normalizedRows = await deps.db
			.select({
				id: deps.schema.artifacts.id,
				metadataJson: deps.schema.artifacts.metadataJson,
			})
			.from(deps.schema.artifacts)
			.where(inArray(deps.schema.artifacts.id, idChunk));
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

	if (!options.snapshot) return { byStatus, byTier, failedDocuments };

	// Measure the documents the snapshot named that have since SUCCEEDED. A
	// document still queued, or one that failed, has not been rewritten, so
	// comparing it would report a shrink that has not happened.
	const succeededSources = new Set(
		rows
			.filter((row) => row.status === "succeeded" && row.sourceArtifactId)
			.map((row) => row.sourceArtifactId as string),
	);
	const wanted = Object.keys(options.snapshot.documents).filter((id) =>
		succeededSources.has(id),
	);

	const after = new Map<
		string,
		{ contentLength: number; chunkCount: number }
	>();
	for (const idChunk of chunked(wanted, SQL_VARIABLE_CHUNK)) {
		const currentRows = await deps.db
			.select({
				sourceArtifactId: deps.schema.artifactLinks.relatedArtifactId,
				contentLength: sql<number>`coalesce(length(${deps.schema.artifacts.contentText}), 0)`,
				chunkCount: sql<number>`(
					select count(*) from artifact_chunks
					where artifact_chunks.artifact_id = ${deps.schema.artifacts.id}
				)`,
			})
			.from(deps.schema.artifactLinks)
			.innerJoin(
				deps.schema.artifacts,
				eq(deps.schema.artifactLinks.artifactId, deps.schema.artifacts.id),
			)
			.where(
				and(
					inArray(deps.schema.artifactLinks.relatedArtifactId, idChunk),
					eq(deps.schema.artifactLinks.linkType, "derived_from"),
					eq(deps.schema.artifacts.type, "normalized_document"),
				),
			);
		for (const row of currentRows) {
			if (!row.sourceArtifactId) continue;
			// The rewrite keeps the artifact id, so there is still exactly one
			// normalized artifact per source; first row wins if a database ever
			// held two, matching `getNormalizedArtifactForSource`'s oldest-link
			// rule closely enough for a size report.
			if (after.has(row.sourceArtifactId)) continue;
			after.set(row.sourceArtifactId, {
				contentLength: row.contentLength,
				chunkCount: row.chunkCount,
			});
		}
	}

	return {
		byStatus,
		byTier,
		failedDocuments,
		compared: after.size,
		shrunk: findShrunkDocuments(
			options.snapshot,
			after,
			options.shrinkThreshold ?? DEFAULT_SHRINK_THRESHOLD,
		),
	};
}

// ── Reporting ───────────────────────────────────────────────────────────

/**
 * The label the per-type breakdown groups on: the file's extension, or its
 * MIME type when it has none. Derived here rather than through the registry on
 * purpose — the report should say what is actually in the library, including
 * the extensions the registry does not recognise (which `getIntakeRoute`
 * routes to `mineru` by fallback, so they DO get enqueued and an operator
 * should see them by name before that happens).
 */
function fileTypeLabel(fileName: string, mimeType: string | null): string {
	const dot = fileName.lastIndexOf(".");
	const extension = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
	if (/^[a-z0-9]{1,8}$/.test(extension)) return extension;
	return mimeType?.trim() || "(no extension)";
}

function printDryRunReport(plan: BackfillPlan, limit: number | null): void {
	const included = plan.items.filter((item) => item.include);
	const excluded = plan.items.filter((item) => !item.include);
	const toEnqueue = selectLimitedBatch(included, limit);

	// The endpoint, not the key. An operator reading this line can tell at a
	// glance whether the script resolved the same backend the app runs on.
	console.log(`MinerU:        ${plan.mineruApiUrl || "(not configured)"}`);
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
	const byType = new Map<string, number>();
	const byTier = new Map<string, number>();
	let totalBytes = 0;
	for (const item of toEnqueue) {
		byRoute.set(item.route, (byRoute.get(item.route) ?? 0) + 1);
		byUser.set(item.doc.userId, (byUser.get(item.doc.userId) ?? 0) + 1);
		const type = fileTypeLabel(item.doc.fileName, item.doc.mimeType);
		byType.set(type, (byType.get(type) ?? 0) + 1);
		const tier = item.effectiveTier ?? "(no tier — direct text)";
		byTier.set(tier, (byTier.get(tier) ?? 0) + 1);
		totalBytes += item.doc.sizeBytes;
	}
	console.log("\nPer intake route (documents this run would enqueue):");
	for (const [route, count] of byRoute) console.log(`  ${route}  ${count}`);
	// Documented since the runbook was written, and never actually printed. It
	// is also the line that tells an operator how much of a whole-library run is
	// pasted screenshots: every image format is `mineru`-routed, so a library
	// with 400 PNGs in it books 400 MinerU parses that the route breakdown above
	// shows only as "mineru 400".
	console.log("\nPer file type:");
	for (const [type, count] of [...byType].sort((a, b) => b[1] - a[1])) {
		console.log(`  ${type}  ${count}`);
	}
	console.log("\nPer requested tier:");
	for (const [tier, count] of [...byTier].sort((a, b) => b[1] - a[1])) {
		console.log(`  ${tier}  ${count}`);
	}
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

	// `in_flight` broken out by the status it is in flight AT. A handful of
	// `queued` rows is an ordinary busy queue; a pile of `parsing` rows is a
	// worker that died, and those are skipped by every run of this script until
	// the server's stale sweep reclaims them — which an operator watching a
	// backfill stall needs to be told, not left to infer from one number.
	const inFlightByStatus = new Map<string, number>();
	for (const item of excluded) {
		if (item.skipReason !== "in_flight") continue;
		const status = item.jobStatus ?? "unknown";
		inFlightByStatus.set(status, (inFlightByStatus.get(status) ?? 0) + 1);
	}
	if (inFlightByStatus.size > 0) {
		console.log("\nAlready in flight, by ledger status:");
		for (const [status, count] of inFlightByStatus) {
			console.log(`  ${status}  ${count}`);
		}
	}

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

/** "12% of before", or "n/a" when there was no before to be a fraction of. */
function percentOf(after: number, before: number): string {
	if (before <= 0) return "n/a";
	return `${Math.round((after / before) * 100)}% of before`;
}

function printStatusReport(report: StatusReport, threshold: number): void {
	console.log(
		"Backfill progress (from the ledger, requested_by = 'backfill'):\n",
	);
	console.log("By status:");
	for (const [status, count] of Object.entries(report.byStatus)) {
		console.log(`  ${status}  ${count}`);
	}
	if (report.shrunk) {
		// In the status summary, next to the ledger's own counts, because "how
		// many documents came back smaller" belongs with "how many succeeded" —
		// a run of 900 successes and 40 shrunk is not a clean run.
		console.log(`  shrunk  ${report.shrunk.length}`);
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

	if (!report.shrunk) return;

	console.log(
		`\nShrink check (against ${report.comparedAgainst ?? "the snapshot"}):`,
	);
	console.log(
		`  ${report.compared ?? 0} succeeded document(s) compared; flagged below ${Math.round(threshold * 100)}% of their previous size.`,
	);
	if (report.shrunk.length === 0) {
		console.log("  Nothing shrank past the threshold.");
		return;
	}
	console.log(
		"\n  These came back much smaller. Nothing was changed — open them and look:",
	);
	for (const doc of report.shrunk) {
		// Each dimension carries its OWN percentage. `remainingFraction` is the
		// worse of the two, and printing it against the text counts read as a
		// contradiction whenever it was the chunk table that collapsed: "10000 →
		// 9900 chars (3% of before)" is the kind of line that makes an operator
		// distrust the whole report.
		console.log(
			`  ${doc.artifactId}  ${doc.fileName}\n` +
				`    user ${doc.userId}\n` +
				`    text   ${doc.beforeLength} → ${doc.afterLength} chars (${percentOf(doc.afterLength, doc.beforeLength)})\n` +
				`    chunks ${doc.beforeChunks} → ${doc.afterChunks} (${percentOf(doc.afterChunks, doc.beforeChunks)})`,
		);
	}
	console.log(
		"\n  A document here still has the NEW parse; the old text is gone. If the\n" +
			"  old parse was better, the source file is untouched — re-upload it, or\n" +
			"  re-extract at a different tier from the Knowledge list.",
	);
}

// ── main ────────────────────────────────────────────────────────────────

export async function main(argv: string[]): Promise<number> {
	try {
		return await run(argv);
	} catch (error) {
		if (error instanceof BackfillUsageError) {
			console.error(`ERROR: ${error.message}`);
			return 1;
		}
		throw error;
	}
}

async function run(argv: string[]): Promise<number> {
	const databasePath = process.env.DATABASE_PATH?.trim();
	if (!databasePath) {
		console.error(
			"ERROR: DATABASE_PATH must be set explicitly, e.g.\n" +
				"  DATABASE_PATH=./data/chat.db npx tsx scripts/backfill-extractions.ts",
		);
		return 1;
	}

	// better-sqlite3 CREATES a missing file. A mistyped DATABASE_PATH therefore
	// used to produce a brand-new, empty database, zero migrations, zero
	// artifacts — and a dry run that cheerfully reported "Eligible: 0
	// document(s)", which is exactly what a finished backfill looks like. On a
	// once-only production operation that is the difference between "done" and
	// "never ran".
	const { existsSync } = await import("node:fs");
	if (!existsSync(databasePath)) {
		console.error(
			`ERROR: DATABASE_PATH does not exist: ${databasePath}\n` +
				"       (this script never creates a database; check the path)",
		);
		return 1;
	}

	const args = parseArgs(argv);

	// `--verify <snapshot>` is the status report plus the shrink check, so it
	// implies `--status` rather than being a separate mode an operator has to
	// remember to combine.
	if (args.status || args.verify) {
		const snapshot = args.verify
			? await readBackfillSnapshot(args.verify)
			: undefined;
		const report = await buildStatusReport(args.since, {
			...(snapshot ? { snapshot } : {}),
			shrinkThreshold: args.shrinkThreshold,
		});
		if (args.verify) report.comparedAgainst = args.verify;
		printStatusReport(report, args.shrinkThreshold);
		// Always 0. A shrink is something to look at, not a failed command —
		// exiting non-zero would make a deploy script treat "40 documents worth
		// checking" as "the backfill broke", which it is not.
		return 0;
	}

	if (args.onlyFailed) {
		const plan = await buildBackfillPlan(args);
		const deps = await loadDeps();
		const jobIds = plan.items
			.map((item) => item.jobId)
			.filter((id): id is string => Boolean(id));
		const jobRows: Array<
			typeof deps.schema.documentExtractionJobs.$inferSelect
		> = [];
		for (const idChunk of chunked(jobIds, SQL_VARIABLE_CHUNK)) {
			jobRows.push(
				...(await deps.db
					.select()
					.from(deps.schema.documentExtractionJobs)
					.where(inArray(deps.schema.documentExtractionJobs.id, idChunk))),
			);
		}
		const byId = new Map(
			jobRows.map((row) => [
				row.id,
				{
					requestedBy: row.requestedBy,
					status: row.status,
					retryable: row.retryable,
					updatedAt: row.updatedAt,
				},
			]),
		);
		const items = filterOnlyFailed(plan, byId, args.since).map((item) => ({
			...item,
			include: true,
		}));
		console.log(
			`--only-failed: ${items.length} document(s) with a user-retryable backfill failure.`,
		);
		if (!args.apply) {
			for (const item of selectLimitedBatch(items, args.limit)) {
				console.log(`  ${item.doc.artifactId}  ${item.doc.fileName}`);
			}
			console.log(
				"\nDry run — nothing was enqueued. Re-run with --apply to re-enqueue these.",
			);
			return 0;
		}
		const result = await applyBackfillPlan(items, {
			limit: args.limit,
			tier: plan.tier,
		});
		printApplySummary(result);
		return result.failed.length > 0 ? 1 : 0;
	}

	const plan = await buildBackfillPlan(args);

	if (!args.apply) {
		printDryRunReport(plan, args.limit);
		return 0;
	}

	const toApply = plan.items.filter((item) => item.include);
	const result = await applyBackfillPlan(toApply, {
		limit: args.limit,
		tier: plan.tier,
	});
	printApplySummary(result);
	return result.failed.length > 0 ? 1 : 0;
}

function printApplySummary(result: ApplyResult): void {
	if (result.snapshotPath) {
		console.log(
			`\nWhen the queue has drained, check what the re-parse did to these:\n` +
				`  npx tsx scripts/backfill-extractions.ts --verify ${result.snapshotPath}`,
		);
	}
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
