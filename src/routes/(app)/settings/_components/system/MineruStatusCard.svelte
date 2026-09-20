<script lang="ts">
// What the configured MinerU server says about itself, read live.
//
// The twelve MINERU_* rows below this card are all settings an admin can only
// verify by trying an upload; this says up front which version answers, which
// quality tiers it offers, and which output formats it can produce — so
// "Default quality tier: standard" stops being a guess that fails hours later
// on somebody's document.
//
// It owns its own fetching rather than taking the report as a prop: it is
// rendered only on the Integrations page, so nothing is probed until an admin
// looks, and the pane above does not have to thread state it never reads.
import { AlertTriangle, RefreshCw } from "@lucide/svelte";
import {
	fetchAdminMineruStatus,
	type MineruStatusReport,
} from "$lib/client/api/admin-system-health";
import { t } from "$lib/i18n";
import "./system.css";

let {
	load = fetchAdminMineruStatus,
}: {
	/** Injected in tests. */
	load?: (options: { refresh?: boolean }) => Promise<MineruStatusReport>;
} = $props();

let report = $state<MineruStatusReport | null>(null);
let loading = $state(false);
let refreshing = $state(false);
let error = $state("");

async function loadStatus(refresh = false) {
	if (refresh) refreshing = true;
	else loading = true;
	error = "";
	try {
		report = await load({ refresh });
	} catch (caught: unknown) {
		error =
			caught instanceof Error && caught.message
				? caught.message
				: $t("admin.mineruStatus.errors.load");
	} finally {
		loading = false;
		refreshing = false;
	}
}

$effect(() => {
	void loadStatus();
});

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

function formatBytes(bytes: number | null): string {
	if (bytes === null) return "";
	const mb = bytes / (1024 * 1024);
	return mb >= 1 ? `${Math.round(mb)} MB` : `${bytes} B`;
}

const statusLabel = $derived(
	!report
		? $t("admin.mineruStatus.unknown")
		: report.reachable
			? $t("admin.mineruStatus.reachable")
			: $t("admin.mineruStatus.unreachable"),
);

const statusClass = $derived(
	!report
		? "sys-pill-muted"
		: report.reachable
			? "sys-pill-ok"
			: "sys-pill-warn",
);

const tierText = $derived(
	report && report.tiers.length > 0
		? report.tiers.map((tier) => tier.id).join(", ")
		: "",
);

const formatText = $derived(
	report && report.outputFormats.length > 0
		? report.outputFormats.join(", ")
		: "",
);

const none = $derived($t("admin.mineruStatus.none"));
</script>

<div class="sys-card-inset" data-testid="mineru-status-card">
	<div class="sys-card-head">
		<span class="sys-grow">
			<h4 class="sys-card-title">{$t('admin.mineruStatus.title')}</h4>
			<p class="sys-card-desc">{$t('admin.mineruStatus.description')}</p>
		</span>
		<span class="sys-card-actions">
			<span class={`sys-pill ${statusClass}`} data-testid="mineru-status-pill">
				{statusLabel}
			</span>
			<button
				type="button"
				class="sys-mini"
				disabled={loading || refreshing}
				onclick={() => void loadStatus(true)}
			>
				<RefreshCw size={12} strokeWidth={2} aria-hidden="true" />
				{refreshing
					? $t('admin.mineruStatus.checking')
					: $t('admin.mineruStatus.recheck')}
			</button>
		</span>
	</div>

	{#if loading && !report}
		<p class="sys-sm sys-muted">{$t('admin.mineruStatus.loading')}</p>
	{:else if error}
		<p class="sys-error" role="alert">{error}</p>
	{:else if report}
		{#if !report.reachable && report.error}
			<div class="sys-banner sys-banner-warn">
				<span class="sys-banner-icon">
					<AlertTriangle size={14} strokeWidth={2} aria-hidden="true" />
				</span>
				<span data-testid="mineru-status-error">
					<b>{report.error.code}</b>
					{report.error.message}
				</span>
			</div>
		{/if}

		<dl class="sys-kv">
			<div data-testid="mineru-status-row-endpoint">
				<dt>{$t('admin.mineruStatus.endpoint')}</dt>
				<dd class="sys-mono">{report.baseUrl || none}</dd>
			</div>
			<div data-testid="mineru-status-row-version">
				<dt>{$t('admin.mineruStatus.version')}</dt>
				<dd class="sys-mono">{report.version ?? none}</dd>
			</div>
			<div data-testid="mineru-status-row-tiers">
				<dt>{$t('admin.mineruStatus.tiers')}</dt>
				<dd class="sys-mono">{tierText || none}</dd>
			</div>
			<div data-testid="mineru-status-row-outputFormats">
				<dt>{$t('admin.mineruStatus.outputFormats')}</dt>
				<dd class="sys-mono">{formatText || none}</dd>
			</div>
			{#if report.accessLevel}
				<div data-testid="mineru-status-row-accessLevel">
					<dt>{$t('admin.mineruStatus.accessLevel')}</dt>
					<dd class="sys-mono">{report.accessLevel}</dd>
				</div>
			{/if}
			{#if report.limits?.maxFileSizeBytes}
				<div data-testid="mineru-status-row-maxFileSize">
					<dt>{$t('admin.mineruStatus.maxFileSize')}</dt>
					<dd class="sys-mono">{formatBytes(report.limits.maxFileSizeBytes)}</dd>
				</div>
			{/if}
			{#if report.limits?.maxPagesPerFile}
				<div data-testid="mineru-status-row-maxPages">
					<dt>{$t('admin.mineruStatus.maxPages')}</dt>
					<dd class="sys-mono">{report.limits.maxPagesPerFile}</dd>
				</div>
			{/if}
		</dl>

		{#if report.checkedAt}
			<p class="sys-xs sys-muted" data-testid="mineru-status-checked">
				{$t('admin.mineruStatus.checked', {
					time: formatCheckedAt(report.checkedAt),
				})}{report.cached ? ` · ${$t('admin.mineruStatus.cached')}` : ''}
			</p>
		{/if}
	{/if}
</div>

<style>
.sys-card-inset {
	margin: 0 0 12px;
	padding: 12px 14px;
	border: 1px solid var(--border);
	border-radius: 10px;
	background: var(--surface-2, transparent);
}

.sys-kv {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
	gap: 6px 18px;
	margin: 10px 0 6px;
}

.sys-kv div {
	display: flex;
	justify-content: space-between;
	gap: 12px;
	min-width: 0;
}

.sys-kv dt {
	color: var(--text-muted);
	font-size: 0.78rem;
	white-space: nowrap;
}

.sys-kv dd {
	margin: 0;
	font-size: 0.78rem;
	overflow-wrap: anywhere;
	text-align: right;
}
</style>
