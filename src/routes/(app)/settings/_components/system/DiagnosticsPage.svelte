<script lang="ts">
// Read-only. Tool health, effective configuration and routing coverage used to
// scroll past between settings cards as if they were settings; they are one
// page now, marked read-only, with three tabs in the analytics kit's idiom.
import { AlertTriangle, RefreshCw, Search } from "@lucide/svelte";
import type {
	BuiltinModelResolution,
	EffectiveConfigReport,
	EffectiveConfigSource,
	ToolHealthSnapshot,
	ToolHealthStatus,
} from "$lib/client/api/admin-system-health";
import { SURFACED_ADMIN_CONFIG_KEYS } from "$lib/config/admin-config-registry";
import { t, type I18nKey } from "$lib/i18n";
import SettingsAdminRoutingRegions from "../SettingsAdminRoutingRegions.svelte";
import SystemTabs from "./SystemTabs.svelte";
import "./system.css";

let {
	activeTab = $bindable("toolHealth"),
	toolHealth = null,
	toolHealthLoading = false,
	toolHealthRefreshing = false,
	toolHealthError = "",
	effectiveConfig = null,
	effectiveConfigLoading = false,
	effectiveConfigError = "",
	onRefreshToolHealth,
	onRefreshEffectiveConfig,
}: {
	activeTab?: string;
	toolHealth?: ToolHealthSnapshot | null;
	toolHealthLoading?: boolean;
	toolHealthRefreshing?: boolean;
	toolHealthError?: string;
	effectiveConfig?: EffectiveConfigReport | null;
	effectiveConfigLoading?: boolean;
	effectiveConfigError?: string;
	onRefreshToolHealth: () => void;
	onRefreshEffectiveConfig: () => void;
} = $props();

let configFilter = $state("");
let configScope = $state<"all" | "overridden" | "env" | "hidden">("all");

const TOOL_HEALTH_STATUS_LABEL: Record<ToolHealthStatus, I18nKey> = {
	healthy: "admin.toolHealth.status.healthy",
	degraded: "admin.toolHealth.status.degraded",
	unconfigured: "admin.toolHealth.status.unconfigured",
};

const TOOL_HEALTH_STATUS_CLASS: Record<ToolHealthStatus, string> = {
	healthy: "sys-pill-ok",
	degraded: "sys-pill-warn",
	unconfigured: "sys-pill-muted",
};

const EFFECTIVE_CONFIG_SOURCE_LABEL: Record<EffectiveConfigSource, I18nKey> = {
	admin_config: "admin.effectiveConfig.source.admin_config",
	env: "admin.effectiveConfig.source.env",
	default: "admin.effectiveConfig.source.default",
};

const EFFECTIVE_CONFIG_RESOLVED_FROM_LABEL: Record<
	BuiltinModelResolution["resolvedFrom"],
	I18nKey
> = {
	providers_table: "admin.effectiveConfig.models.resolvedFrom.providers_table",
	admin_config_env:
		"admin.effectiveConfig.models.resolvedFrom.admin_config_env",
	unresolved: "admin.effectiveConfig.models.resolvedFrom.unresolved",
};

function formatCheckedAt(iso: string): string {
	if (!iso) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return date.toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

function formatLatency(latencyMs: number | null): string {
	return latencyMs === null ? "—" : `${Math.round(latencyMs)} ms`;
}

const degraded = $derived(
	(toolHealth?.tools ?? []).filter((tool) => tool.status === "degraded"),
);

const entries = $derived(effectiveConfig?.entries ?? []);

const overriddenCount = $derived(
	entries.filter((entry) => entry.adminOverride !== null).length,
);
const envCount = $derived(
	entries.filter((entry) => entry.source === "env").length,
);
const hiddenCount = $derived(
	entries.filter((entry) => !SURFACED_ADMIN_CONFIG_KEYS.has(entry.key)).length,
);

const filteredEffectiveConfig = $derived.by(() => {
	const needle = configFilter.trim().toLowerCase();
	return entries.filter((entry) => {
		if (configScope === "overridden" && entry.adminOverride === null) {
			return false;
		}
		if (configScope === "env" && entry.source !== "env") return false;
		if (configScope === "hidden" && SURFACED_ADMIN_CONFIG_KEYS.has(entry.key)) {
			return false;
		}
		if (!needle) return true;
		return (
			entry.key.toLowerCase().includes(needle) ||
			entry.effectiveValue.toLowerCase().includes(needle) ||
			(entry.adminOverride ?? "").toLowerCase().includes(needle)
		);
	});
});
</script>

<section
	class="sys-card"
	id="settings-tool-health-card"
	data-testid="tool-health-section"
>
	<div class="sys-card-head">
		<span class="sys-grow">
			<h3 class="sys-card-title">{$t('admin.system.diagnostics.title')}</h3>
			<p class="sys-card-desc">{$t('admin.system.diagnostics.description')}</p>
		</span>
		<span class="sys-card-actions">
			{#if toolHealth?.checkedAt}
				<span class="sys-xs sys-muted">
					{$t('admin.system.diagnostics.checked', {
						time: formatCheckedAt(toolHealth.checkedAt),
					})}
				</span>
			{/if}
			<button
				type="button"
				class="sys-mini"
				disabled={toolHealthLoading || toolHealthRefreshing}
				onclick={onRefreshToolHealth}
			>
				<RefreshCw size={12} strokeWidth={2} aria-hidden="true" />
				{toolHealthRefreshing
					? $t('admin.toolHealth.refreshing')
					: $t('admin.system.diagnostics.rerun')}
			</button>
		</span>
	</div>

	<SystemTabs
		bind:active={activeTab}
		label={$t('admin.system.diagnostics.title')}
		tabs={[
			{
				id: 'toolHealth',
				label: $t('admin.system.diagnostics.tabs.toolHealth'),
				badge: degraded.length > 0 ? String(degraded.length) : undefined,
			},
			{
				id: 'effectiveConfig',
				label: $t('admin.system.diagnostics.tabs.effectiveConfig'),
			},
			{ id: 'routing', label: $t('admin.system.diagnostics.tabs.routing') },
		]}
	/>

	{#if activeTab === 'toolHealth'}
		<div id="sys-tabpanel-toolHealth" role="tabpanel" aria-labelledby="sys-tab-toolHealth">
			{#if toolHealthLoading && !toolHealth}
				<p class="sys-sm sys-muted">{$t('admin.toolHealth.loading')}</p>
			{:else if toolHealthError}
				<p class="sys-error" role="alert">{toolHealthError}</p>
			{:else if !toolHealth || toolHealth.tools.length === 0}
				<p class="sys-sm sys-muted">{$t('admin.toolHealth.empty')}</p>
			{:else}
				<div class="sys-table-scroll">
					<table class="sys-table" data-testid="tool-health-table">
						<thead>
							<tr>
								<th>{$t('admin.toolHealth.columns.tool')}</th>
								<th>{$t('admin.toolHealth.columns.backend')}</th>
								<th>{$t('admin.toolHealth.columns.status')}</th>
								<th>{$t('admin.toolHealth.columns.latency')}</th>
								<th>{$t('admin.toolHealth.columns.detail')}</th>
								<th>{$t('admin.toolHealth.columns.checked')}</th>
							</tr>
						</thead>
						<tbody>
							{#each toolHealth.tools as tool (tool.id)}
								<tr data-testid={`tool-health-row-${tool.id}`}>
									<td class="sys-td-primary sys-mono">{tool.tool}</td>
									<td>{tool.backend}</td>
									<td>
										<span
											class={`sys-pill ${TOOL_HEALTH_STATUS_CLASS[tool.status]}`}
											data-status={tool.status}
										>
											{$t(TOOL_HEALTH_STATUS_LABEL[tool.status])}
										</span>
									</td>
									<td class="sys-num">{formatLatency(tool.latencyMs)}</td>
									<td class="sys-xs" style="max-width: 28rem">{tool.detail ?? '—'}</td>
									<td class="sys-xs sys-num">{formatCheckedAt(tool.checkedAt)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>

				{#if degraded.length > 0}
					<div class="sys-banner sys-banner-warn" style="margin-top: 12px">
						<span class="sys-banner-icon">
							<AlertTriangle size={14} strokeWidth={2} aria-hidden="true" />
						</span>
						<span>
							<b>
								{degraded.length === 1
									? $t('admin.system.diagnostics.degradedOne')
									: $t('admin.system.diagnostics.degradedMany', {
											count: String(degraded.length),
										})}
							</b>
							{$t('admin.system.diagnostics.degradedDetail')}
						</span>
					</div>
				{/if}

				<p class="sys-xs sys-muted" style="margin-top: 8px">
					{$t('admin.toolHealth.lastChecked', {
						time: formatCheckedAt(toolHealth.checkedAt),
					})}
				</p>
			{/if}
		</div>
	{:else if activeTab === 'effectiveConfig'}
		<div
			id="sys-tabpanel-effectiveConfig"
			role="tabpanel"
			aria-labelledby="sys-tab-effectiveConfig"
			data-testid="effective-config-section"
		>
			{#if effectiveConfigLoading && !effectiveConfig}
				<p class="sys-sm sys-muted">{$t('admin.effectiveConfig.loading')}</p>
			{:else if effectiveConfigError}
				<p class="sys-error" role="alert">{effectiveConfigError}</p>
			{:else if effectiveConfig}
				<div class="sys-row-control" style="margin-bottom: 10px">
					<span class="sys-search" style="max-width: 320px">
						<span class="sys-search-icon">
							<Search size={14} strokeWidth={2} aria-hidden="true" />
						</span>
						<input
							class="sys-input sys-input-wide"
							type="search"
							placeholder={$t('admin.effectiveConfig.filter')}
							aria-label={$t('admin.effectiveConfig.filterA11y')}
							bind:value={configFilter}
						/>
					</span>
					{#each [{ id: 'overridden', label: $t('admin.system.diagnostics.filter.overridden', { count: String(overriddenCount) }) }, { id: 'env', label: $t('admin.system.diagnostics.filter.env', { count: String(envCount) }) }, { id: 'hidden', label: $t('admin.system.diagnostics.filter.hidden', { count: String(hiddenCount) }) }] as scope (scope.id)}
						<button
							type="button"
							class="sys-mini"
							class:sys-mini-on={configScope === scope.id}
							aria-pressed={configScope === scope.id}
							onclick={() =>
								(configScope =
									configScope === scope.id
										? 'all'
										: (scope.id as typeof configScope))}
						>
							{scope.label}
						</button>
					{/each}
					<span class="sys-grow"></span>
					<button type="button" class="sys-mini" onclick={onRefreshEffectiveConfig}>
						<RefreshCw size={12} strokeWidth={2} aria-hidden="true" />
						{$t('admin.effectiveConfig.refresh')}
					</button>
				</div>

				<p class="sys-xs sys-muted" style="margin-bottom: 8px">
					{$t('admin.system.diagnostics.generated', {
						time: formatCheckedAt(effectiveConfig.generatedAt),
						count: String(entries.length),
					})}
				</p>

				{#if filteredEffectiveConfig.length === 0}
					<p class="sys-sm sys-muted">{$t('admin.effectiveConfig.empty')}</p>
				{:else}
					<div class="sys-table-scroll" style="max-height: 32rem; overflow-y: auto">
						<table class="sys-table" data-testid="effective-config-table">
							<thead>
								<tr>
									<th>{$t('admin.effectiveConfig.columns.key')}</th>
									<th>{$t('admin.effectiveConfig.columns.value')}</th>
									<th>{$t('admin.effectiveConfig.columns.source')}</th>
									<th>{$t('admin.effectiveConfig.columns.override')}</th>
								</tr>
							</thead>
							<tbody>
								{#each filteredEffectiveConfig as entry (entry.key)}
									<tr data-testid={`effective-config-row-${entry.key}`}>
										<td class="sys-td-primary sys-mono">{entry.key}</td>
										<td class="sys-mono" style="max-width: 28rem; word-break: break-all">
											{entry.effectiveValue === ''
												? $t('admin.effectiveConfig.notSet')
												: entry.effectiveValue}
										</td>
										<td data-source={entry.source}>
											<span class="sys-pill sys-pill-outline">
												{$t(EFFECTIVE_CONFIG_SOURCE_LABEL[entry.source])}
											</span>
										</td>
										<td class="sys-mono" style="max-width: 16rem; word-break: break-all">
											{#if entry.adminOverride === null}
												<span class="sys-pill sys-pill-muted">
													{$t('admin.system.diagnostics.noOverride')}
												</span>
											{:else}
												<span class="sys-pill sys-pill-warn">
													{$t('admin.system.diagnostics.overridesEnv', {
														value: entry.envValue || $t('admin.system.emptyValue'),
													})}
												</span>
											{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}

				{#if effectiveConfig.models.length > 0}
					<div class="sys-banner" style="margin-top: 12px; display: block">
						<p class="sys-help" style="margin: 0 0 6px">
							{$t('admin.system.diagnostics.builtInNote')}
						</p>
						<ul class="sys-stack" style="gap: 4px; list-style: none; padding: 0; margin: 0">
							{#each effectiveConfig.models as model (model.key)}
								<li class="sys-xs" data-testid={`effective-config-model-${model.key}`}>
									<span class="sys-mono-text sys-td-primary">{model.key}</span>
									·
									<span>
										{model.providerRowFound
											? model.providerEnabled
												? $t('admin.effectiveConfig.models.enabled')
												: $t('admin.effectiveConfig.models.disabled')
											: $t('admin.effectiveConfig.models.missing')}
									</span>
									·
									<span>{$t(EFFECTIVE_CONFIG_RESOLVED_FROM_LABEL[model.resolvedFrom])}</span>
									{#if model.resolvedModelId}
										·
										<span>
											{$t('admin.effectiveConfig.models.resolvesTo', {
												model: model.resolvedModelId,
											})}
										</span>
									{/if}
									{#if model.shadowedOverrides.length > 0}
										<p style="color: var(--warning); margin: 2px 0 0">
											{$t('admin.effectiveConfig.models.shadowed', {
												keys: model.shadowedOverrides.join(', '),
											})}
										</p>
									{/if}
									{#if model.error}
										<p style="color: var(--danger); margin: 2px 0 0">{model.error}</p>
									{/if}
								</li>
							{/each}
						</ul>
					</div>
				{/if}
			{/if}
		</div>
	{:else}
		<div id="sys-tabpanel-routing" role="tabpanel" aria-labelledby="sys-tab-routing">
			<SettingsAdminRoutingRegions />
		</div>
	{/if}
</section>
