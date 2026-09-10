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
		effect: "unwired",
	},
	{
		key: "FILE_PRODUCTION_RENDERER_TIMEOUT_MS",
		group: "limits",
		control: int(1000, undefined, "s", 1000),
		effect: "unwired",
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

	// --- Atlas internals ----------------------------------------------------
	{
		key: "ATLAS_PIPELINE",
		group: "atlas",
		control: { kind: "select", options: ["v1", "v2", "v3"] },
		effect: "live",
	},
	{
		key: "ATLAS_V2_QUESTIONS_OVERVIEW",
		group: "atlas",
		control: int(1, 20),
		effect: "live",
	},
	{
		key: "ATLAS_V2_QUESTIONS_IN_DEPTH",
		group: "atlas",
		control: int(1, 20),
		effect: "live",
	},
	{
		key: "ATLAS_V2_QUESTIONS_EXHAUSTIVE",
		group: "atlas",
		control: int(1, 20),
		effect: "live",
	},
	{
		key: "ATLAS_V2_ROUNDS_OVERVIEW",
		group: "atlas",
		control: int(1, 4),
		effect: "live",
	},
	{
		key: "ATLAS_V2_ROUNDS_IN_DEPTH",
		group: "atlas",
		control: int(1, 4),
		effect: "live",
	},
	{
		key: "ATLAS_V2_ROUNDS_EXHAUSTIVE",
		group: "atlas",
		control: int(1, 4),
		effect: "live",
	},
	{
		key: "ATLAS_V2_MAX_WORDS_OVERVIEW",
		group: "atlas",
		control: int(200, undefined, "words"),
		effect: "live",
	},
	{
		key: "ATLAS_V2_MAX_WORDS_IN_DEPTH",
		group: "atlas",
		control: int(200, undefined, "words"),
		effect: "live",
	},
	{
		key: "ATLAS_V2_MAX_WORDS_EXHAUSTIVE",
		group: "atlas",
		control: int(200, undefined, "words"),
		effect: "live",
	},
	{
		key: "ATLAS_V2_MAX_SOURCES_OVERVIEW",
		group: "atlas",
		control: int(1),
		effect: "live",
	},
	{
		key: "ATLAS_V2_MAX_SOURCES_IN_DEPTH",
		group: "atlas",
		control: int(1),
		effect: "live",
	},
	{
		key: "ATLAS_V2_MAX_SOURCES_EXHAUSTIVE",
		group: "atlas",
		control: int(1),
		effect: "live",
	},
	{
		key: "ATLAS_V2_ENTAILMENT_BATCH",
		group: "atlas",
		control: int(1, 25),
		effect: "live",
	},
	{
		key: "ATLAS_V2_WRITER_CONCURRENCY",
		group: "atlas",
		control: int(1, 8),
		effect: "live",
	},
	{
		key: "ATLAS_OVERVIEW_MAX_OUTPUT_TOKENS",
		group: "atlas",
		control: int(1, undefined, "tokens"),
		effect: "live",
	},
	{
		key: "ATLAS_IN_DEPTH_MAX_OUTPUT_TOKENS",
		group: "atlas",
		control: int(1, undefined, "tokens"),
		effect: "live",
	},
	{
		key: "ATLAS_EXHAUSTIVE_MAX_OUTPUT_TOKENS",
		group: "atlas",
		control: int(1, undefined, "tokens"),
		effect: "live",
	},
	{
		key: "ATLAS_MAX_WRITER_PROMPT_CHARS",
		group: "atlas",
		control: int(100, undefined, "chars"),
		effect: "live",
	},
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
	"ATLAS_SEARCH_CONCURRENCY",
	"ATLAS_SEARCH_BATCH_DELAY_MS",
	"ATLAS_SYNTHESIS_MODEL",
	"ATLAS_AUDIT_MODEL",
	"ATLAS_V3_ASK_MODEL",
	"ATLAS_V3_RESEARCHER_MODEL",
	"ATLAS_V3_OUTLINE_MODEL",
	"ATLAS_V3_WRITER_MODEL",
	"ATLAS_V3_CRITIC_MODEL",
	"ATLAS_V3_VERIFIER_MODEL",
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
	"MINERU_API_URL",
	"MINERU_TIMEOUT_MS",
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
	if (spec.control.kind !== "int") return stored;
	const scale = spec.control.scale;
	if (!scale || stored.trim() === "") return stored;
	const parsed = Number.parseInt(stored, 10);
	if (!Number.isFinite(parsed)) return stored;
	return String(Math.round(parsed / scale));
}

/** The number the field shows → the storage value. */
export function fromDisplayNumber(
	spec: AdminConfigKeySpec,
	shown: string,
): string {
	if (spec.control.kind !== "int") return shown;
	const scale = spec.control.scale;
	if (!scale || shown.trim() === "") return shown.trim();
	const parsed = Number.parseInt(shown, 10);
	if (!Number.isFinite(parsed)) return shown.trim();
	return String(parsed * scale);
}
