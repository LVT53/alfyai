<script lang="ts">
// The settings that used to exist only in the environment file. Seven groups
// from the board plus one for the debug flags and stream limits; every row
// says the same four things, and nothing here needs a restart.
import { AlertTriangle, Bolt, Eye, Info, Search } from "@lucide/svelte";
import {
	ADVANCED_GROUP_ORDER,
	ADVANCED_KEY_SPECS,
	type AdminConfigKeySpec,
	type AdvancedGroupId,
} from "$lib/config/admin-config-registry";
import { t, type I18nKey } from "$lib/i18n";
import AdvancedRow from "./AdvancedRow.svelte";
import SystemCollapsible from "./SystemCollapsible.svelte";
import { pageForKey } from "./pages";
import "./system.css";

let {
	adminConfig,
	envDefaults = {},
	secretChangedAt = {},
	highlightKey = "",
	isDirty,
	setValue,
	resetValue,
	revertValue,
}: {
	adminConfig: Record<string, string>;
	envDefaults?: Record<string, string>;
	secretChangedAt?: Record<string, string>;
	highlightKey?: string;
	isDirty: (key: string) => boolean;
	setValue: (key: string, value: string) => void;
	resetValue: (key: string) => void;
	revertValue: (key: string) => void;
} = $props();

let filter = $state("");

// Keys a named page already owns (the Atlas pipeline selector) are not
// repeated here — one home per key, or the badges would double-count.
const OWNED = ADVANCED_KEY_SPECS.filter(
	(spec) => pageForKey(spec.key) === "advanced",
);

const GROUP_LABEL_KEY: Record<AdvancedGroupId, I18nKey> = {
	limits: "admin.system.advanced.groups.limits",
	atlas: "admin.system.advanced.groups.atlas",
	embeddings: "admin.system.advanced.groups.embeddings",
	memory: "admin.system.advanced.groups.memory",
	routing: "admin.system.advanced.groups.routing",
	models: "admin.system.advanced.groups.models",
	integrations: "admin.system.advanced.groups.integrations",
	debug: "admin.system.advanced.groups.debug",
};

const SANDBOX_CONSTANTS = [
	["SANDBOX_TIMEOUT_MS", "90 s"],
	["SANDBOX_TIMEOUT_JS_MS", "135 s"],
	["SANDBOX_MEMORY_MB", "2 048"],
	["SANDBOX_MAX_FILE_MB", "100"],
	["SANDBOX_MAX_OUTPUT_FILES", "20"],
	["SANDBOX_MAX_TOTAL_OUTPUT_MB", "50"],
] as const;

// Kept out of admin config on purpose — they choose what container runs, where
// it binds, which container gets a command, or they are the key that encrypts
// every stored provider secret.
const ENV_ONLY_KEYS = [
	"SESSION_SECRET",
	"DATABASE_PATH",
	"ALFYAI_API_SIGNING_KEY",
	"PARALLEL_BASE_URL",
	"DOCKER_HOST",
	"ROUTING_ORS_IMAGE",
	"ROUTING_GEOCODER_IMPORT_CONTAINER",
	"ROUTING_REGION_HOST_IP",
	"ROUTING_REGION_XMX",
	"ROUTING_REGIONS_DIR",
	"ROUTING_ON_DEMAND_ENABLED",
	"ROUTING_EXTRACT_MIRRORS",
	"MAP_TILE_UPSTREAM_BASE_URL",
	"MAP_TILES_DIR",
	"TEI_EMBEDDER_API_KEY",
	"TEI_RERANKER_API_KEY",
	"TITLE_GEN_API_KEY",
	"CONTEXT_SUMMARIZER_API_KEY",
	"BODY_SIZE_LIMIT",
];

function labelOf(spec: AdminConfigKeySpec): string {
	return $t(`admin.system.keys.${spec.key}.label` as I18nKey);
}

function meaningOf(spec: AdminConfigKeySpec): string {
	return $t(`admin.system.keys.${spec.key}.meaning` as I18nKey);
}

const matching = $derived.by(() => {
	const needle = filter.trim().toLowerCase();
	if (!needle) return OWNED;
	return OWNED.filter(
		(spec) =>
			spec.key.toLowerCase().includes(needle) ||
			labelOf(spec).toLowerCase().includes(needle) ||
			meaningOf(spec).toLowerCase().includes(needle) ||
			(envDefaults[spec.key] ?? "").toLowerCase().includes(needle),
	);
});

function specsIn(group: AdvancedGroupId): AdminConfigKeySpec[] {
	return matching.filter((spec) => spec.group === group);
}

const searchMath = $derived.by(() => {
	const read = (key: string, fallback: number) => {
		const parsed = Number.parseInt(adminConfig[key] ?? "", 10);
		return Number.isFinite(parsed) ? parsed : fallback;
	};
	return [
		{
			profile: $t("admin.system.atlas.profile.overview"),
			questions: read("ATLAS_V2_QUESTIONS_OVERVIEW", 6),
			rounds: read("ATLAS_V2_ROUNDS_OVERVIEW", 1),
		},
		{
			profile: $t("admin.system.atlas.profile.inDepth"),
			questions: read("ATLAS_V2_QUESTIONS_IN_DEPTH", 10),
			rounds: read("ATLAS_V2_ROUNDS_IN_DEPTH", 2),
		},
		{
			profile: $t("admin.system.atlas.profile.exhaustive"),
			questions: read("ATLAS_V2_QUESTIONS_EXHAUSTIVE", 16),
			rounds: read("ATLAS_V2_ROUNDS_EXHAUSTIVE", 3),
		},
	];
});

const totalKeys = OWNED.length;
</script>

<div class="sys-stack" data-testid="system-page-advanced">
	<div class="sys-page-head">
		<span class="sys-grow">
			<span class="sys-label" style="gap: 9px">
				<span class="sys-page-title">{$t('admin.system.advanced.title')}</span>
				<span class="sys-chip sys-chip-live">
					<Bolt size={9} strokeWidth={2.5} aria-hidden="true" />
					{$t('admin.system.advanced.restartFree')}
				</span>
			</span>
			<p class="sys-card-desc" style="max-width: 760px">
				{$t('admin.system.advanced.description', { count: String(totalKeys) })}
			</p>
		</span>
	</div>

	<div class="sys-search" style="max-width: 420px">
		<span class="sys-search-icon">
			<Search size={14} strokeWidth={2} aria-hidden="true" />
		</span>
		<input
			class="sys-input sys-input-wide"
			type="search"
			data-testid="advanced-filter"
			aria-label={$t('admin.system.advanced.search')}
			placeholder={$t('admin.system.advanced.search')}
			bind:value={filter}
		/>
	</div>

	{#each ADVANCED_GROUP_ORDER as group (group)}
		{@const specs = specsIn(group)}
		{#if specs.length > 0}
			<SystemCollapsible
				title={$t(GROUP_LABEL_KEY[group])}
				count={specs.length}
				testId={`advanced-group-${group}`}
			>
				{#if group === 'embeddings'}
					<div class="sys-banner sys-banner-warn" style="margin-bottom: 12px">
						<span class="sys-banner-icon">
							<AlertTriangle size={14} strokeWidth={2} aria-hidden="true" />
						</span>
						<span>{$t('admin.system.advanced.teiWarning')}</span>
					</div>
				{:else if group === 'models'}
					<div class="sys-banner sys-banner-accent" style="margin-bottom: 12px">
						<span class="sys-banner-icon">
							<Info size={14} strokeWidth={2} aria-hidden="true" />
						</span>
						<span>{$t('admin.system.advanced.contextRule')}</span>
					</div>
				{:else if group === 'atlas'}
					<div class="sys-banner" style="margin-bottom: 12px">
						<span class="sys-banner-icon">
							<Info size={14} strokeWidth={2} aria-hidden="true" />
						</span>
						<span>
							<b>{$t('admin.system.atlas.searchMath')}</b>
							{#each searchMath as row (row.profile)}
								<span class="sys-pill sys-pill-outline" style="margin-left: 6px">
									{$t('admin.system.atlas.searchMathRow', {
										profile: row.profile,
										questions: String(row.questions),
										rounds: String(row.rounds),
										total: String(row.questions * row.rounds),
									})}
								</span>
							{/each}
						</span>
					</div>
				{/if}

				<div class="sys-table-scroll">
					<table class="sys-table">
						<thead>
							<tr>
								<th>{$t('admin.system.settingLabel')}</th>
								<th>{$t('admin.system.valueLabel')}</th>
								<th>{$t('admin.system.defaultLabel')}</th>
								<th>{$t('admin.system.takesEffect')}</th>
							</tr>
						</thead>
						<tbody>
							{#each specs as spec (spec.key)}
								<AdvancedRow
									{spec}
									value={adminConfig[spec.key] ?? ''}
									defaultValue={envDefaults[spec.key] ?? ''}
									secretChangedAt={secretChangedAt[spec.key] ?? ''}
									dirty={isDirty(spec.key)}
									highlighted={highlightKey === spec.key}
									onchange={(next) => setValue(spec.key, next)}
									onReset={() => resetValue(spec.key)}
									onRevert={() => revertValue(spec.key)}
								/>
							{/each}
						</tbody>
					</table>
				</div>

				{#if group === 'limits'}
					<div class="sys-banner" style="margin-top: 12px; display: block">
						<p class="sys-eyebrow" style="margin: 0 0 6px">
							{$t('admin.system.advanced.sandboxTitle')}
						</p>
						<div class="sys-grid3">
							{#each SANDBOX_CONSTANTS as [name, value] (name)}
								<span class="sys-xs">
									<span class="sys-key" style="display: inline">{name}</span>
									<span class="sys-num" style="float: right">{value}</span>
								</span>
							{/each}
						</div>
						<p class="sys-help" style="margin-top: 8px">
							{$t('admin.system.advanced.sandboxNote')}
						</p>
					</div>
				{:else if group === 'routing'}
					<div class="sys-row-control" style="margin-top: 12px">
						<span class="sys-xs sys-muted">
							{$t('admin.system.advanced.routingReference')}
						</span>
						<span class="sys-pill sys-pill-outline sys-mono-text">
							ORS_BASE_URL · {adminConfig.ORS_BASE_URL || $t('admin.system.emptyValue')}
						</span>
						<span class="sys-pill sys-pill-outline sys-mono-text">
							GEOCODER_BASE_URL · {adminConfig.GEOCODER_BASE_URL || $t('admin.system.emptyValue')}
						</span>
					</div>
				{/if}
			</SystemCollapsible>
		{/if}
	{/each}

	{#if matching.length === 0}
		<p class="sys-empty">{$t('admin.system.search.empty', { query: filter })}</p>
	{/if}

	<section class="sys-card" data-testid="advanced-env-only">
		<div class="sys-card-head">
			<span class="sys-grow">
				<h3 class="sys-card-title">{$t('admin.system.advanced.envOnlyTitle')}</h3>
				<p class="sys-card-desc">{$t('admin.system.advanced.envOnlyNote')}</p>
			</span>
			<span class="sys-card-actions">
				<span class="sys-pill sys-pill-muted">
					<Eye size={10} strokeWidth={2.5} aria-hidden="true" />
					{$t('admin.system.nav.readOnly')}
				</span>
			</span>
		</div>
		<div class="sys-row-control">
			{#each ENV_ONLY_KEYS as key (key)}
				<span class="sys-pill sys-pill-outline sys-mono-text">{key}</span>
			{/each}
		</div>
	</section>
</div>
