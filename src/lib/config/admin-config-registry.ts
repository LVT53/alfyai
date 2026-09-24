/**
 * The admin System screen's key registry.
 *
 * `ADMIN_CONFIG_KEYS` (config-store.ts) says which keys an admin *may* write.
 * This registry says, for the keys the Advanced page renders, HOW to render and
 * validate each one and WHEN a change takes effect. It lives outside
 * `$lib/server` on purpose: both the Svelte pages and the server-side tests
 * import it, and a `$lib/server` module cannot be reached from the browser.
 *
 * Honesty rules for `effect`:
 *   - "live"     — every consumer calls `getConfig()` at call time, so the next
 *                  request/report/probe uses the new value.
 *   - "next-run" — a scheduler reads the value when it computes its next tick,
 *                  so the change lands on the next sweep rather than instantly.
 *   - "restart"  — the value is read once at start-up; only a process restart
 *                  applies it. The two `createIntervalJob` schedulers are this:
 *                  `interval-job.ts` resolves the period inside `start()` and
 *                  arms one `setInterval` with it, and `refreshConfig()` never
 *                  restarts them, so their `periodMinutes` getter runs exactly
 *                  once per process.
 *   - "unwired"  — the key is stored and applied to the config object, but no
 *                  code path reads that field yet. The row says so instead of
 *                  promising an effect it cannot have.
 */

export type AdminConfigEffect = "live" | "next-run" | "restart" | "unwired";

export type AdminConfigUnit =
	| "ms"
	| "s"
	| "min"
	| "days"
	| "months"
	| "mb"
	| "chars"
	| "tokens"
	| "words"
	| "count";

export type AdminConfigControl =
	| {
			kind: "int";
			min?: number;
			max?: number;
			unit?: AdminConfigUnit;
			/** Divisor between the stored value and the number the field shows. */
			scale?: number;
	  }
	// The same numeric field as "int", except a fraction is a legal value. Only
	// use it where the fraction is meaningful; `int` remains the default so a
	// typo like "1.5" in a count cannot quietly round.
	| {
			kind: "number";
			min?: number;
			max?: number;
			unit?: AdminConfigUnit;
			/** Divisor between the stored value and the number the field shows. */
			scale?: number;
	  }
	| { kind: "text" }
	| { kind: "url" }
	| { kind: "bool" }
	| { kind: "secret" }
	| { kind: "select"; options: readonly string[] };

export type AdvancedGroupId =
	| "limits"
	| "atlas"
	| "embeddings"
	| "memory"
	| "routing"
	| "models"
	| "integrations"
	| "debug";

export interface AdminConfigKeySpec {
	key: string;
	group: AdvancedGroupId;
	control: AdminConfigControl;
	effect: AdminConfigEffect;
	/** Extra note rendered under the meaning line, e.g. an SSRF caveat. */
	warn?: boolean;
}

const MB = 1024 * 1024;

function int(
	min?: number,
	max?: number,
	unit?: AdminConfigUnit,
	scale?: number,
): AdminConfigControl {
	return { kind: "int", min, max, unit, scale };
}

function number(
	min?: number,
	max?: number,
	unit?: AdminConfigUnit,
	scale?: number,
): AdminConfigControl {
	return { kind: "number", min, max, unit, scale };
}

/**
 * Every key the Advanced page renders, in render order inside its group.
 * Group order is `ADVANCED_GROUP_ORDER`.
 */
export const ADVANCED_KEY_SPECS: readonly AdminConfigKeySpec[] = [
	// --- Resource limits (file production) ---------------------------------
	{
		key: "FILE_PRODUCTION_MAX_OUTPUTS",
		group: "limits",
		control: int(1),
		effect: "live",
	},
	{
		key: "FILE_PRODUCTION_MAX_SOURCE_JSON_BYTES",
		group: "limits",
		control: int(1024, undefined, "mb", MB),
		effect: "live",
	},
	{
		key: "FILE_PRODUCTION_MAX_PROJECTION_BYTES",
		group: "limits",
		control: int(1024, undefined, "mb", MB),
		effect: "live",
	},
	{
		key: "FILE_PRODUCTION_MAX_PDF_PAGES",
		group: "limits",
		control: int(1),
		effect: "live",
	},
	{
		key: "FILE_PRODUCTION_MAX_TABLE_ROWS",
		group: "limits",
		control: int(1),
		effect: "live",
	},
	{
		key: "FILE_PRODUCTION_MAX_TABLE_COLUMNS",
		group: "limits",
		control: int(1),
		effect: "live",
	},
	{
		key: "FILE_PRODUCTION_MAX_CHART_DATA_POINTS",
		group: "limits",
		control: int(1),
		effect: "live",
	},
	{
		key: "FILE_PRODUCTION_MAX_CHART_SERIES",
		group: "limits",
		control: int(1),
		effect: "live",
	},
	{
		key: "FILE_PRODUCTION_MAX_IMAGE_COUNT",
		group: "limits",
		control: int(1),
		effect: "live",
	},
	{
		key: "FILE_PRODUCTION_MAX_IMAGE_BYTES",
		group: "limits",
		control: int(1024, undefined, "mb", MB),
		effect: "live",
	},
	{
		key: "FILE_PRODUCTION_MAX_TOTAL_IMAGE_BYTES",
		group: "limits",
		control: int(1024, undefined, "mb", MB),
		effect: "live",
	},
	{
		key: "FILE_PRODUCTION_SANDBOX_TIMEOUT_MS",
		group: "limits",
		control: int(1000, undefined, "s", 1000),
		// Live: `execution-adapter.ts` passes it to `executeCode` as the
		// container's deadline for program-mode jobs, so a change applies to the
		// next job. It was `unwired` for as long as the sandbox killed on
		// `getSandboxTimeout()`'s hard-coded 90 s whatever this said. Only file
		// production passes it — `run_python` shares `executeCode` but keeps the
		// constant, because its envelope timeout is derived from that constant.
		effect: "live",
	},
	{
		key: "FILE_PRODUCTION_RENDERER_TIMEOUT_MS",
		group: "limits",
		control: int(1000, undefined, "s", 1000),
		// Live: `execution-adapter.ts` reads it through `getFileProductionLimits()`
		// when it builds the attempt's `RenderBudget`, so a change applies to the
		// next job rather than the next restart. It was `unwired` for as long as
		// the deadline was a number nobody enforced.
		effect: "live",
	},
	{
		key: "FILE_PRODUCTION_MAX_OUTPUT_FILE_BYTES",
		group: "limits",
		control: int(1024, undefined, "mb", MB),
		effect: "live",
	},
	{
		key: "FILE_PRODUCTION_MAX_TOTAL_OUTPUT_BYTES",
		group: "limits",
		control: int(1024, undefined, "mb", MB),
		effect: "live",
	},
	{
		key: "FILE_PRODUCTION_STALE_ATTEMPT_MS",
		group: "limits",
		control: int(60000, 3600000, "min", 60000),
		effect: "live",
	},
	{
		key: "FILE_PRODUCTION_WORKER_ENABLED",
		group: "limits",
		control: { kind: "bool" },
		effect: "live",
	},

	// --- Resource limits (document extraction) ------------------------------
	// All twelve are "live": `extraction/config.ts` resolves every one through
	// getConfig() at the moment it is used — per claim, per failure, per wait —
	// so a change lands on the next job rather than the next restart.
	{
		key: "DOCUMENT_EXTRACTION_WORKER_ENABLED",
		group: "limits",
		control: { kind: "bool" },
		effect: "live",
	},
	{
		key: "DOCUMENT_EXTRACTION_MAX_CONCURRENCY",
		group: "limits",
		control: int(1, 16),
		effect: "live",
	},
	{
		key: "DOCUMENT_EXTRACTION_PER_USER_CONCURRENCY",
		group: "limits",
		control: int(1, 16),
		effect: "live",
	},
	{
		key: "DOCUMENT_EXTRACTION_MAX_ATTEMPTS",
		group: "limits",
		control: int(1, 10),
		effect: "live",
	},
	{
		key: "DOCUMENT_EXTRACTION_RETRY_BASE_MS",
		group: "limits",
		control: int(100, 600000, "ms"),
		effect: "live",
	},
	{
		key: "DOCUMENT_EXTRACTION_RETRY_MAX_MS",
		group: "limits",
		control: int(1000, 3600000, "s", 1000),
		effect: "live",
	},
	{
		key: "DOCUMENT_EXTRACTION_OUTAGE_WINDOW_MS",
		group: "limits",
		control: int(60000, 86400000, "min", 60000),
		effect: "live",
	},
	{
		key: "DOCUMENT_EXTRACTION_STALE_ATTEMPT_MS",
		group: "limits",
		control: int(60000, 3600000, "min", 60000),
		effect: "live",
	},
	{
		key: "DOCUMENT_EXTRACTION_HEARTBEAT_MS",
		group: "limits",
		control: int(1000, 120000, "s", 1000),
		effect: "live",
	},
	{
		key: "DOCUMENT_EXTRACTION_INLINE_BUDGET_MS",
		group: "limits",
		control: int(0, 15000, "ms"),
		effect: "live",
	},
	{
		key: "DOCUMENT_EXTRACTION_PREFLIGHT_WAIT_MS",
		group: "limits",
		control: int(0, 30000, "ms"),
		effect: "live",
	},
	{
		key: "DOCUMENT_EXTRACTION_MAX_DIRECT_TEXT_BYTES",
		group: "limits",
		control: int(1024, 134217728, "mb", MB),
		effect: "live",
	},

	// --- Atlas internals ----------------------------------------------------
	// Atlas runs pipeline v3 exclusively (Phase B of the v3-only
	// consolidation); the ATLAS_PIPELINE switch and the v1/v2-only knobs
	// (questions/rounds/word-and-source caps per profile, entailment batch,
	// writer concurrency, per-profile output-token caps, writer prompt chars)
	// were removed with the v1/v2 pipelines. Atlas v3's own knobs
	// (ATLAS_V3_*) are surfaced on the AI tasks page instead of here.
	{
		key: "ATLAS_STALE_MONTHS",
		group: "atlas",
		control: int(1, undefined, "months"),
		effect: "live",
	},

	// --- Embeddings & reranker ---------------------------------------------
	{
		key: "TEI_EMBEDDER_URL",
		group: "embeddings",
		control: { kind: "url" },
		effect: "live",
	},
	{
		key: "TEI_EMBEDDER_MODEL",
		group: "embeddings",
		control: { kind: "text" },
		effect: "live",
	},
	{
		key: "TEI_EMBEDDER_BATCH_SIZE",
		group: "embeddings",
		control: int(1),
		effect: "live",
	},
	{
		key: "TEI_RERANKER_URL",
		group: "embeddings",
		control: { kind: "url" },
		effect: "live",
	},
	{
		key: "TEI_RERANKER_MODEL",
		group: "embeddings",
		control: { kind: "text" },
		effect: "unwired",
	},
	{
		key: "TEI_RERANKER_MAX_TEXTS",
		group: "embeddings",
		control: int(1),
		effect: "live",
	},
	{
		key: "TEI_TIMEOUT_MS",
		group: "embeddings",
		control: int(100, undefined, "ms"),
		effect: "live",
	},

	// --- Memory & working set ----------------------------------------------
	{
		key: "MEMORY_JUDGE_DRY_RUN",
		group: "memory",
		control: { kind: "bool" },
		effect: "live",
	},
	{
		key: "MEMORY_JUDGE_IDLE_MINUTES",
		group: "memory",
		control: int(1, undefined, "min"),
		effect: "next-run",
	},
	{
		// Armed once by `createIntervalJob().start()` from hooks.server.ts; the
		// `periodMinutes` getter is never re-invoked (interval-job.ts:62-66).
		key: "MEMORY_CONSOLIDATION_INTERVAL_MINUTES",
		group: "memory",
		control: int(1, undefined, "min"),
		effect: "restart",
	},
	{
		// Same spine as consolidation above, plus: `start()` treats 0 as "never
		// arm", so 0 → 30 cannot take hold without a restart either.
		key: "MEMORY_MAINTENANCE_INTERVAL_MINUTES",
		group: "memory",
		control: int(0, undefined, "min"),
		effect: "restart",
	},
	{
		key: "WORKING_SET_DOCUMENT_TOKEN_BUDGET",
		group: "memory",
		control: int(100, undefined, "tokens"),
		effect: "unwired",
	},
	{
		key: "WORKING_SET_PROMPT_TOKEN_BUDGET",
		group: "memory",
		control: int(1000, undefined, "tokens"),
		effect: "unwired",
	},
	{
		key: "SMALL_FILE_THRESHOLD_CHARS",
		group: "memory",
		control: int(100, undefined, "chars"),
		effect: "live",
	},

	// --- Routing tuning ------------------------------------------------------
	{
		key: "ORS_COVERAGE_LABEL",
		group: "routing",
		control: { kind: "text" },
		effect: "live",
	},
	{
		key: "ROUTING_REGION_IDLE_MINUTES",
		group: "routing",
		control: int(5, undefined, "min"),
		effect: "next-run",
	},
	{
		key: "ROUTING_GTFS_REFRESH_DAYS",
		group: "routing",
		control: int(1, undefined, "days"),
		effect: "next-run",
	},
	{
		key: "ROUTING_GTFS_MAX_MB",
		group: "routing",
		control: int(10, undefined, "mb"),
		effect: "live",
	},
	{
		key: "ROUTING_REGION_MAX_PBF_MB",
		group: "routing",
		control: int(50, undefined, "mb"),
		effect: "live",
	},
	{
		key: "ROUTING_GTFS_FEED_EXCLUDE",
		group: "routing",
		control: { kind: "text" },
		effect: "live",
	},

	// --- Built-in model tuning ----------------------------------------------
	{
		key: "MODEL_1_MAX_TOKENS",
		group: "models",
		control: int(1, undefined, "tokens"),
		effect: "live",
	},
	{
		key: "MODEL_1_REASONING_EFFORT",
		group: "models",
		control: {
			kind: "select",
			options: ["", "none", "minimal", "low", "medium", "high", "max", "xhigh"],
		},
		effect: "live",
	},
	{
		key: "MODEL_1_THINKING_TYPE",
		group: "models",
		control: { kind: "select", options: ["", "enabled", "disabled"] },
		effect: "live",
	},
	{
		key: "MODEL_1_MAX_MODEL_CONTEXT",
		group: "models",
		control: int(1, undefined, "tokens"),
		effect: "live",
	},
	{
		key: "MODEL_1_COMPACTION_UI_THRESHOLD",
		group: "models",
		control: int(1, undefined, "tokens"),
		effect: "live",
	},
	{
		key: "MODEL_1_TARGET_CONSTRUCTED_CONTEXT",
		group: "models",
		control: int(1, undefined, "tokens"),
		effect: "live",
	},
	{
		key: "MODEL_1_MAX_MESSAGE_LENGTH",
		group: "models",
		control: int(1, undefined, "chars"),
		effect: "live",
	},
	{
		key: "MODEL_2_MAX_TOKENS",
		group: "models",
		control: int(1, undefined, "tokens"),
		effect: "live",
	},
	{
		key: "MODEL_2_REASONING_EFFORT",
		group: "models",
		control: {
			kind: "select",
			options: ["", "none", "minimal", "low", "medium", "high", "max", "xhigh"],
		},
		effect: "live",
	},
	{
		key: "MODEL_2_THINKING_TYPE",
		group: "models",
		control: { kind: "select", options: ["", "enabled", "disabled"] },
		effect: "live",
	},
	{
		key: "MODEL_2_MAX_MODEL_CONTEXT",
		group: "models",
		control: int(1, undefined, "tokens"),
		effect: "live",
	},
	{
		key: "MODEL_2_COMPACTION_UI_THRESHOLD",
		group: "models",
		control: int(1, undefined, "tokens"),
		effect: "live",
	},
	{
		key: "MODEL_2_TARGET_CONSTRUCTED_CONTEXT",
		group: "models",
		control: int(1, undefined, "tokens"),
		effect: "live",
	},
	{
		key: "MODEL_2_MAX_MESSAGE_LENGTH",
		group: "models",
		control: int(1, undefined, "chars"),
		effect: "live",
	},

	// --- Integrations --------------------------------------------------------
	{
		key: "GOOGLE_OAUTH_CLIENT_ID",
		group: "integrations",
		control: { kind: "text" },
		effect: "live",
	},
	{
		key: "GOOGLE_OAUTH_CLIENT_SECRET",
		group: "integrations",
		control: { kind: "secret" },
		effect: "live",
	},
	{
		key: "ONEDRIVE_CLIENT_ID",
		group: "integrations",
		control: { kind: "text" },
		effect: "live",
	},
	{
		key: "ONEDRIVE_CLIENT_SECRET",
		group: "integrations",
		control: { kind: "secret" },
		effect: "live",
	},
	{
		key: "OWNTRACKS_RECORDER_URL",
		group: "integrations",
		control: { kind: "url" },
		effect: "live",
		warn: true,
	},
	{
		key: "OWNTRACKS_RECORDER_USER",
		group: "integrations",
		control: { kind: "text" },
		effect: "live",
	},
	{
		key: "OWNTRACKS_RECORDER_PASS",
		group: "integrations",
		control: { kind: "secret" },
		effect: "live",
	},
	{
		key: "NATIVE_HISTORY_ENABLED",
		group: "integrations",
		control: { kind: "bool" },
		effect: "live",
	},
	{
		key: "TITLE_GEN_URL",
		group: "integrations",
		control: { kind: "url" },
		effect: "live",
	},
	{
		key: "CONTEXT_SUMMARIZER_URL",
		group: "integrations",
		control: { kind: "url" },
		effect: "live",
	},
	{
		// A billing setting for the same integration as PARALLEL_API_KEY, so it
		// sits in the same group and on the same named page. It needs a spec
		// rather than being stored raw: the value changes what users are
		// charged, so "abc" or "-1" must be a 400 here instead of a number the
		// applier silently ignores or the env parser quietly rewrites to 5.
		// `number`, not `int`: the allowance is a dollar amount and 2.5 is a
		// legal setting.
		key: "PARALLEL_FREE_MONTHLY_USD",
		group: "integrations",
		control: number(0, 1000000),
		effect: "live",
	},

	// --- MinerU document extraction ------------------------------------------
	// Dual-registered on purpose: these keys keep their rows on the Integrations
	// page (NAMED_PAGE_KEYS) and also have a spec here, which is what routes
	// them through validateAdminConfigValue. Before this, MINERU_TIMEOUT_MS was
	// "path B" only — `MINERU_TIMEOUT_MS: "abc"` was stored in admin_config and
	// then silently never applied. AdvancedPage filters on
	// `pageForKey(spec.key) === "advanced"`, so a named-page key with a spec
	// renders exactly once.
	{
		key: "MINERU_API_URL",
		group: "integrations",
		control: { kind: "url" },
		effect: "live",
	},
	{
		key: "MINERU_API_KEY",
		group: "integrations",
		control: { kind: "secret" },
		effect: "live",
	},
	{
		key: "MINERU_DEFAULT_TIER",
		group: "integrations",
		control: {
			kind: "select",
			options: ["auto", "flash", "basic", "standard", "advanced"],
		},
		effect: "live",
	},
	{
		key: "MINERU_OCR_MODE",
		group: "integrations",
		control: { kind: "select", options: ["auto", "txt", "ocr"] },
		effect: "live",
	},
	{
		key: "MINERU_JOB_TIMEOUT_MS",
		group: "integrations",
		control: int(10000, 3600000, "s", 1000),
		effect: "live",
	},
	{
		key: "MINERU_POLL_MIN_MS",
		group: "integrations",
		control: int(250, 60000, "ms"),
		effect: "live",
	},
	{
		key: "MINERU_POLL_MAX_MS",
		group: "integrations",
		control: int(1000, 300000, "s", 1000),
		effect: "live",
	},
	{
		key: "MINERU_REQUEST_TIMEOUT_MS",
		group: "integrations",
		control: int(1000, 300000, "s", 1000),
		effect: "live",
	},
	{
		key: "MINERU_TRANSFER_TIMEOUT_MS",
		group: "integrations",
		control: int(10000, 3600000, "s", 1000),
		effect: "live",
	},
	{
		key: "MINERU_CAPABILITIES_TTL_MS",
		group: "integrations",
		control: int(0, 3600000, "s", 1000),
		effect: "live",
	},
	{
		key: "MINERU_BUNDLE_MAX_BYTES",
		group: "integrations",
		control: int(1048576, 536870912, "mb", MB),
		effect: "live",
	},
	{
		// The TOTAL a user's parse bundles may occupy, against
		// MINERU_BUNDLE_MAX_BYTES's per-bundle cap. 0 means unlimited, which is
		// what every box did before this key existed.
		key: "MINERU_BUNDLE_USER_QUOTA_BYTES",
		group: "integrations",
		control: int(0, 549755813888, "mb", MB),
		effect: "live",
	},
	{
		key: "MINERU_STRUCTURE_CHUNKING_ENABLED",
		group: "integrations",
		control: { kind: "bool" },
		effect: "live",
	},

	// --- Debug & stream limits ----------------------------------------------
	{
		key: "CONTEXT_DIAGNOSTICS_DEBUG",
		group: "debug",
		control: { kind: "bool" },
		effect: "live",
	},
	{
		key: "ATTACHMENT_TRACE_DEBUG",
		group: "debug",
		control: { kind: "bool" },
		effect: "live",
	},
	{
		key: "NORMAL_CHAT_DEBUG_OUTBOUND",
		group: "debug",
		control: { kind: "bool" },
		effect: "live",
	},
	{
		key: "CONCURRENT_STREAM_LIMIT",
		group: "debug",
		control: int(1),
		effect: "live",
	},
	{
		key: "PER_USER_STREAM_LIMIT",
		group: "debug",
		control: int(1),
		effect: "live",
	},
] as const;

export const ADVANCED_GROUP_ORDER: readonly AdvancedGroupId[] = [
	"limits",
	"atlas",
	"embeddings",
	"memory",
	"routing",
	"models",
	"integrations",
	"debug",
];

/** Spec lookup by key. */
export const ADVANCED_KEY_SPEC_BY_KEY: ReadonlyMap<string, AdminConfigKeySpec> =
	new Map(ADVANCED_KEY_SPECS.map((spec) => [spec.key, spec]));

/** Key → when a change takes effect. Used by the UI badge and by tests. */
export const ADMIN_CONFIG_EFFECT_BY_KEY: Readonly<
	Record<string, AdminConfigEffect>
> = Object.fromEntries(
	ADVANCED_KEY_SPECS.map((spec) => [spec.key, spec.effect]),
);

/**
 * The keys whose control must be inert.
 *
 * `effect: "unwired"` used to be a label and nothing more: the row rendered a
 * normal, editable field with a small "no effect yet" chip beside it, so an
 * admin could type a number, press Save, get "Configuration saved." and have
 * changed nothing at all. A setting that accepts a value it will never read is
 * worse than a setting that is missing.
 *
 * Every key here was checked against its would-be consumer before being left
 * unwired; none of them is a one-line hook-up:
 *
 *    FILE_PRODUCTION_RENDERER_TIMEOUT_MS and FILE_PRODUCTION_SANDBOX_TIMEOUT_MS
 *    both used to sit here and no longer do. The renderer one is the attempt's
 *    `RenderBudget` deadline in `execution-adapter.ts`, enforced cooperatively
 *    at page, block and table-row boundaries — see `render-budget.ts` for why a
 *    timer could not have done it. The sandbox one is now passed to
 *    `executeCode` as that run's deadline, which is what `getSandboxTimeout()`
 *    would otherwise have supplied; the shared constant stays as the default so
 *    `run_python`, which uses the same function and derives its envelope
 *    timeout from that constant, is unaffected.
 *  - TEI_RERANKER_MODEL has no field to go in. A Text Embeddings Inference
 *    server serves ONE model per process and its `/rerank` body has no `model`
 *    member; the model is chosen when the container starts. There is no
 *    embedding-model twin in this registry for the same reason.
 *  - WORKING_SET_PROMPT_TOKEN_BUDGET / WORKING_SET_DOCUMENT_TOKEN_BUDGET
 *    collide with two same-named CONSTANTS in knowledge/store/core.ts (3 000
 *    and 1 200) which context-selection.ts uses as `minTotalBudget` floors.
 *    The config defaults are 20 000 / 4 000 — an order of magnitude apart,
 *    because they are not the same quantity. knowledge/AGENTS.md says so
 *    outright: "legacy minimum floors and small-context fallbacks. Do not use
 *    them as final prompt-depth ceilings." Pointing the floor at the admin
 *    value would change chat context selection, not connect a setting.
 *
 * So they stay visible (an admin looking for the key should find it and learn
 * why it does nothing) and stay inert: disabled control, a note saying so, out
 * of the save payload, and dropped-and-reported by `PUT /api/admin/config`
 * (dropped rather than refused, so a caller that still sends one — a tab
 * loaded before this shipped, a provisioning script — keeps being able to save
 * everything else in the same body).
 */
export const UNWIRED_ADMIN_CONFIG_KEYS: ReadonlySet<string> = new Set(
	ADVANCED_KEY_SPECS.filter((spec) => spec.effect === "unwired").map(
		(spec) => spec.key,
	),
);

/**
 * True for a key the UI must not let anyone edit and the API must not store.
 * Takes a plain string so both sides can call it with an unvalidated key.
 */
export function isUnwiredAdminConfigKey(key: string): boolean {
	return UNWIRED_ADMIN_CONFIG_KEYS.has(key);
}

export function advancedKeysInGroup(
	group: AdvancedGroupId,
): AdminConfigKeySpec[] {
	return ADVANCED_KEY_SPECS.filter((spec) => spec.group === group);
}

/**
 * Keys with a control somewhere on the System screen — the Advanced page plus
 * the six named pages. Diagnostics uses it for its "never surfaced in the UI"
 * filter, which must not claim a key is unreachable when it is one click away.
 */
export const SURFACED_ADMIN_CONFIG_KEYS: ReadonlySet<string> = new Set([
	...ADVANCED_KEY_SPECS.map((spec) => spec.key),
	// General
	"COMPOSER_COMMAND_REGISTRY_ENABLED",
	"APP_VERSION_OVERRIDE",
	// Models & providers
	"MODEL_TIMEOUT_FAILOVER_ENABLED",
	"MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS",
	"MODEL_TIMEOUT_FAILOVER_TARGET_MODEL",
	"DEFAULT_NEW_USER_MODEL",
	"MODEL_1_DISPLAY_NAME",
	"MODEL_2_DISPLAY_NAME",
	"MODEL_2_ENABLED",
	// AI tasks
	"ATLAS_WORKER_ENABLED",
	"ATLAS_GLOBAL_ACTIVE_LIMIT",
	"ATLAS_SYNTHESIS_MODEL",
	"ATLAS_AUDIT_MODEL",
	"ATLAS_V3_ASK_MODEL",
	"ATLAS_V3_RESEARCHER_MODEL",
	"ATLAS_V3_OUTLINE_MODEL",
	"ATLAS_V3_WRITER_MODEL",
	"ATLAS_V3_CRITIC_MODEL",
	"ATLAS_V3_CRITIC_ROUNDS",
	"ATLAS_V3_RESEARCHER_CONCURRENCY",
	"ATLAS_V3_SEARCHES_PER_STEP",
	"ATLAS_V3_PAGES_PER_QUESTION_OVERVIEW",
	"ATLAS_V3_PAGES_PER_QUESTION_IN_DEPTH",
	"ATLAS_V3_PAGES_PER_QUESTION_EXHAUSTIVE",
	"ATLAS_V3_LANGUAGE_STANDARD_HU",
	"MEMORY_JUDGE_MODEL",
	"MEMORY_CONSOLIDATION_MODEL",
	"TITLE_GEN_MODEL",
	"TITLE_GEN_SYSTEM_PROMPT_EN",
	"TITLE_GEN_SYSTEM_PROMPT_HU",
	"TITLE_GEN_SYSTEM_PROMPT_CODE_APPENDIX_EN",
	"TITLE_GEN_SYSTEM_PROMPT_CODE_APPENDIX_HU",
	"CONTEXT_SUMMARIZER_MODEL",
	"SYSTEM_PROMPT",
	// Integrations & keys
	"PARALLEL_API_KEY",
	"BRAVE_SEARCH_API_KEY",
	// The MinerU keys arrive through the ADVANCED_KEY_SPECS spread above, now
	// that every one of them has a spec.
	"WEB_PUSH_VAPID_PUBLIC_KEY",
	"WEB_PUSH_VAPID_PRIVATE_KEY",
	"WEB_PUSH_VAPID_SUBJECT",
	// Limits
	"MAX_MESSAGE_LENGTH",
	"MAX_FILE_UPLOAD_SIZE",
	"REQUEST_TIMEOUT_MS",
	// Users pane (System analytics exclusions)
	"ANALYTICS_EXCLUDED_USER_IDS",
]);

/**
 * A number as plain decimal text — never exponent notation.
 *
 * The `number` control is written in `^-?\d*\.?\d+$`, and JavaScript switches
 * `String()` to exponent notation below 1e-6 and at 1e21 — so a value
 * canonicalised with plain `String(parsed)` can come out in a spelling this
 * module itself refuses. That is not cosmetic: the canonical string is what
 * gets stored and what the admin field shows, so a stored "1e-7" turned the
 * next save of that key into a 400 and the field could not be written again.
 *
 * The exponent form `String()` writes is already the shortest text that
 * round-trips to the same double, so nothing has to be recomputed — the
 * decimal point only has to move: "1e-7" → "0.0000001", "1.5e-7" →
 * "0.00000015", "1e+21" → "1000000000000000000000". Every number whose
 * `String()` form is already plain is returned exactly as it was, so "2.5"
 * stays "2.5" and "5" stays "5".
 */
export function toPlainDecimal(value: number): string {
	const text = String(value);
	// "NaN" and "Infinity" have no "e" either, and no point to move.
	if (!/[eE]/.test(text)) return text;
	const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(text);
	if (!match) return text;
	const [, sign, whole, fraction = "", exponentText] = match;
	const digits = whole + fraction;
	const point = whole.length + Number(exponentText);
	if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
	if (point >= digits.length) {
		return `${sign}${digits}${"0".repeat(point - digits.length)}`;
	}
	return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

export type AdminConfigValidation =
	| { ok: true; value: string }
	| {
			ok: false;
			reason:
				| "not-a-number"
				| "below-min"
				| "above-max"
				| "invalid-option"
				| "invalid-url";
			limit?: number;
	  };

/**
 * Validates one edited value against its spec, in the storage form (the string
 * that goes into `admin_config`). An empty string is always valid: `PUT` treats
 * it as "delete the override", which is exactly what "Reset to default" means.
 */
export function validateAdminConfigValue(
	spec: AdminConfigKeySpec,
	raw: string,
): AdminConfigValidation {
	const value = raw.trim();
	if (value === "") return { ok: true, value: "" };

	switch (spec.control.kind) {
		case "int": {
			if (!/^-?\d+$/.test(value)) return { ok: false, reason: "not-a-number" };
			const parsed = Number.parseInt(value, 10);
			if (!Number.isFinite(parsed))
				return { ok: false, reason: "not-a-number" };
			if (spec.control.min !== undefined && parsed < spec.control.min) {
				return { ok: false, reason: "below-min", limit: spec.control.min };
			}
			if (spec.control.max !== undefined && parsed > spec.control.max) {
				return { ok: false, reason: "above-max", limit: spec.control.max };
			}
			return { ok: true, value: String(parsed) };
		}
		case "number": {
			// A plain decimal, so "2.5" and ".5" are accepted while exponent
			// notation and stray words are not: this string is stored verbatim
			// and handed to Number.parseFloat by the override applier, where an
			// "e" would silently become a different number, or NaN.
			if (!/^-?\d*\.?\d+$/.test(value)) {
				return { ok: false, reason: "not-a-number" };
			}
			const parsed = Number.parseFloat(value);
			if (!Number.isFinite(parsed))
				return { ok: false, reason: "not-a-number" };
			if (spec.control.min !== undefined && parsed < spec.control.min) {
				return { ok: false, reason: "below-min", limit: spec.control.min };
			}
			if (spec.control.max !== undefined && parsed > spec.control.max) {
				return { ok: false, reason: "above-max", limit: spec.control.max };
			}
			// Canonical form: "2.50" and ".5" are stored as "2.5" and "0.5", the
			// same number the applier will parse — and always in the plain
			// decimal spelling the check above accepts, never the exponent
			// notation `String(0.0000001)` would produce. A stored value the
			// validator refuses is an admin field that cannot be saved again.
			return { ok: true, value: toPlainDecimal(parsed) };
		}
		case "select": {
			return spec.control.options.includes(value)
				? { ok: true, value }
				: { ok: false, reason: "invalid-option" };
		}
		case "bool": {
			// The spellings the appliers read, and nothing else. Silently folding
			// an unrecognised word to "false" would turn a typed "TRUE" into a
			// switched-OFF flag, and would rewrite the "1" that
			// NORMAL_CHAT_DEBUG_OUTBOUND's applier deliberately accepts.
			const normalized = value.toLowerCase();
			if (normalized === "true" || normalized === "1") {
				return { ok: true, value: "true" };
			}
			if (normalized === "false" || normalized === "0") {
				return { ok: true, value: "false" };
			}
			return { ok: false, reason: "invalid-option" };
		}
		case "url": {
			// The appliers hand these straight to fetch: only an absolute http(s)
			// URL can be a recorder or an API base, and a stray word here would
			// only surface as a failed probe later.
			try {
				const parsed = new URL(value);
				if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
					return { ok: false, reason: "invalid-url" };
				}
				return { ok: true, value };
			} catch {
				return { ok: false, reason: "invalid-url" };
			}
		}
		default:
			return { ok: true, value };
	}
}

/** Storage value → the number the field shows (scaled units such as MB or s). */
export function toDisplayNumber(
	spec: AdminConfigKeySpec,
	stored: string,
): string {
	const kind = spec.control.kind;
	if (kind !== "int" && kind !== "number") return stored;
	const scale = spec.control.scale;
	if (!scale || stored.trim() === "") return stored;
	const parsed =
		kind === "int" ? Number.parseInt(stored, 10) : Number.parseFloat(stored);
	if (!Number.isFinite(parsed)) return stored;
	const scaled = parsed / scale;
	// An integer control cannot show a fraction, so its scaled value rounds
	// (a 250 ms timeout is "0 s" on a seconds-scaled field). A fractional
	// control must not round — that is the whole point of the kind.
	return String(kind === "int" ? Math.round(scaled) : scaled);
}

/** The number the field shows → the storage value. */
export function fromDisplayNumber(
	spec: AdminConfigKeySpec,
	shown: string,
): string {
	const kind = spec.control.kind;
	if (kind !== "int" && kind !== "number") return shown;
	const scale = spec.control.scale;
	if (!scale || shown.trim() === "") return shown.trim();
	const parsed =
		kind === "int" ? Number.parseInt(shown, 10) : Number.parseFloat(shown);
	if (!Number.isFinite(parsed)) return shown.trim();
	return String(parsed * scale);
}
