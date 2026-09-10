<script lang="ts">
import { onMount } from "svelte";
import {
	ChevronDown,
	ChevronUp,
	ExternalLink,
	Plus,
	RefreshCw,
	RotateCcw,
	Trash2,
} from "@lucide/svelte";
import { slide } from "svelte/transition";
import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
import { t } from "$lib/i18n";
import { reducedMotionAware } from "$lib/utils/motion";
import "./system/system.css";
import {
	fetchRoutingRegions,
	refreshRoutingRegionTransit,
	removeRoutingRegion,
	retryRoutingRegionFeed,
	requestRoutingRegion,
	retryRoutingRegion,
	setRoutingRegionResident,
	type RoutingRegionSummary,
} from "$lib/client/api/admin";

let regions = $state<RoutingRegionSummary[]>([]);
let configured = $state(true);
let loading = $state(false);
let busyId = $state<string | null>(null);
let error = $state("");
let message = $state("");
let newRegionId = $state("");
// The 60-second poll rebuilds the table; keeping the open feed lists in state
// (rather than in a <details> element) means a refresh no longer closes them.
let expandedRegions = $state<string[]>([]);
let pendingRemove = $state<RoutingRegionSummary | null>(null);

const feedSlide = reducedMotionAware(slide);

function toggleFeeds(regionId: string) {
	expandedRegions = expandedRegions.includes(regionId)
		? expandedRegions.filter((id) => id !== regionId)
		: [...expandedRegions, regionId];
}

async function load() {
	loading = true;
	error = "";
	try {
		const result = await fetchRoutingRegions();
		configured = result.configured;
		regions = result.regions;
	} catch (loadError) {
		error = loadError instanceof Error ? loadError.message : String(loadError);
	} finally {
		loading = false;
	}
}

async function request() {
	const id = newRegionId.trim();
	if (!id) return;
	busyId = id;
	error = "";
	message = "";
	try {
		const outcome = await requestRoutingRegion({ id });
		message =
			outcome.kind === "unknown_region"
				? $t("admin.routingRegions.unknownId")
				: $t("admin.routingRegions.requested");
		newRegionId = "";
		await load();
	} catch (requestError) {
		error =
			requestError instanceof Error
				? requestError.message
				: String(requestError);
	} finally {
		busyId = null;
	}
}

async function retry(id: string) {
	busyId = id;
	error = "";
	try {
		await retryRoutingRegion(id);
		await load();
	} catch (retryError) {
		error =
			retryError instanceof Error ? retryError.message : String(retryError);
	} finally {
		busyId = null;
	}
}

async function toggleResident(region: RoutingRegionSummary) {
	busyId = region.id;
	error = "";
	try {
		await setRoutingRegionResident(region.id, !region.resident);
		await load();
	} catch (patchError) {
		error =
			patchError instanceof Error ? patchError.message : String(patchError);
	} finally {
		busyId = null;
	}
}

async function refreshTimetable(id: string) {
	busyId = id;
	error = "";
	message = "";
	try {
		await refreshRoutingRegionTransit(id);
		message = $t("admin.routingRegions.transitQueued");
		await load();
	} catch (refreshError) {
		error =
			refreshError instanceof Error
				? refreshError.message
				: String(refreshError);
	} finally {
		busyId = null;
	}
}

async function remove(id: string) {
	pendingRemove = null;
	busyId = id;
	error = "";
	try {
		await removeRoutingRegion(id);
		await load();
	} catch (removeError) {
		error =
			removeError instanceof Error ? removeError.message : String(removeError);
	} finally {
		busyId = null;
	}
}

// Per-feed retry: clears that operator's recorded failure and queues the
// region's rebuild, which re-fetches only that feed.
async function retryFeed(regionId: string, feedId: string) {
	busyId = regionId;
	error = "";
	message = "";
	try {
		await retryRoutingRegionFeed(regionId, feedId);
		message = $t("admin.routingRegions.transitQueued");
		await load();
	} catch (retryError) {
		error =
			retryError instanceof Error ? retryError.message : String(retryError);
	} finally {
		busyId = null;
	}
}

// A feed's own state, which is finer than the region's: "stale" and "error"
// on a feed that still has a zip on disk are warnings, not outages.
// One status vocabulary for regions and for the feeds inside them. "none" is
// not a problem — the region simply has no GTFS feed configured — so it must
// not wear the amber "in progress" colour.
function statusPill(status: string): string {
	if (status === "ready" || status === "fresh") return "sys-pill-ok";
	if (status === "error" || status === "failed") return "sys-pill-danger";
	if (status === "none") return "sys-pill-muted";
	return "sys-pill-warn";
}

function formatDate(value: string | null | undefined): string {
	if (!value) return "—";
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("en-GB");
}

function formatSize(bytes: number | null | undefined): string {
	if (!bytes) return "—";
	return `${Math.round(bytes / 1048576)} MB`;
}

// One line that says what the region is actually doing right now: which
// source is serving the download, when a backed-off retry is due, and how
// many attempts it has burned.
function statusDetail(region: RoutingRegionSummary): string {
	if (region.status === "downloading" && region.extractSource) {
		return $t("admin.routingRegions.viaSource", {
			source: region.extractSource,
		});
	}
	if (region.status === "queued" && region.nextAttemptAt) {
		return $t("admin.routingRegions.retryAt", {
			time: formatDate(region.nextAttemptAt),
			attempts: String(region.attempts),
		});
	}
	if (region.status === "ready" && region.extractSource) {
		return $t("admin.routingRegions.viaSource", {
			source: region.extractSource,
		});
	}
	if (region.status === "error" && region.attempts > 0) {
		return $t("admin.routingRegions.attempts", {
			attempts: String(region.attempts),
		});
	}
	return "";
}

onMount(() => {
	void load();
	const timer = setInterval(() => void load(), 60_000);
	return () => clearInterval(timer);
});
</script>

<div data-testid="routing-regions-section">
	<div class="sys-card-head" style="margin-bottom: 10px">
		<span class="sys-grow">
			<p class="sys-card-desc" style="margin-top: 0">
				{$t('admin.routingRegions.description')}
			</p>
			<p class="sys-xs sys-muted" style="margin: 4px 0 0">
				{$t('admin.system.diagnostics.routingNote')}
			</p>
		</span>
		<span class="sys-card-actions">
			<button type="button" class="sys-mini" onclick={() => void load()} disabled={loading}>
				<RefreshCw size={12} strokeWidth={2} aria-hidden="true" />
				{$t('admin.system.diagnostics.refreshNow')}
			</button>
		</span>
	</div>

	{#if !configured}
		<p class="sys-sm sys-muted">{$t('admin.routingRegions.notConfigured')}</p>
	{:else}
		<div class="sys-row-control" style="margin-bottom: 10px">
			<input
				class="sys-input sys-input-md"
				placeholder={$t('admin.routingRegions.idPlaceholder')}
				aria-label={$t('admin.routingRegions.idPlaceholder')}
				bind:value={newRegionId}
				onkeydown={(event) => {
					if (event.key === 'Enter') void request();
				}}
			/>
			<button
				type="button"
				class="sys-mini sys-mini-on"
				onclick={() => void request()}
				disabled={busyId !== null || !newRegionId.trim()}
			>
				<Plus size={12} strokeWidth={2} aria-hidden="true" />
				{$t('admin.routingRegions.request')}
			</button>
			<a
				class="sys-mini"
				href="https://download.geofabrik.de/"
				target="_blank"
				rel="noreferrer"
			>
				<ExternalLink size={12} strokeWidth={2} aria-hidden="true" />
				{$t('admin.routingRegions.catalogue')}
			</a>
		</div>

		{#if error}
			<p class="sys-error" role="alert">{error}</p>
		{/if}
		{#if message}
			<p class="sys-sm sys-muted" role="status">{message}</p>
		{/if}

		<div class="sys-table-scroll">
			<table class="sys-table">
				<thead>
					<tr>
						<th>{$t('admin.routingRegions.colRegion')}</th>
						<th>{$t('admin.routingRegions.colStatus')}</th>
						<th>{$t('admin.routingRegions.colResident')}</th>
						<th>{$t('admin.routingRegions.colGeocoder')}</th>
						<th>{$t('admin.routingRegions.colTransit')}</th>
						<th>{$t('admin.routingRegions.colSize')}</th>
						<th>{$t('admin.routingRegions.colEndpoint')}</th>
						<th>{$t('admin.routingRegions.colLastUsed')}</th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					{#each regions as region (region.id)}
						<tr>
							<td class="sys-td-primary">
								<span class="sys-label">{region.name}</span>
								<span class="sys-key">
									{region.id}{region.managed ? '' : ` · ${$t('admin.routingRegions.legacy')}`}
								</span>
								{#if region.error}
									<p class="sys-error">{region.error}</p>
								{/if}
							</td>
							<td>
								<span class={`sys-pill ${statusPill(region.status)}`}>{region.status}</span>
								{#if statusDetail(region)}
									<p class="sys-xs sys-muted" style="margin: 4px 0 0">{statusDetail(region)}</p>
								{/if}
							</td>
							<td>
								{#if region.managed}
									<button
										type="button"
										role="switch"
										class="sys-toggle"
										aria-checked={region.resident}
										aria-label={$t('admin.routingRegions.colResident')}
										disabled={busyId === region.id}
										onclick={() => void toggleResident(region)}
									>
										<span class="sys-toggle-thumb"></span>
									</button>
								{:else}
									—
								{/if}
							</td>
							<td class="sys-xs">{region.geocoderStatus}</td>
							<td class="sys-xs" data-testid={`transit-${region.id}`}>
								<span class={`sys-pill ${statusPill(region.transitStatus)}`}>
									{region.transitStatus}
								</span>
								{#if region.gtfsDownloadedAt}
									<p class="sys-xs sys-muted" style="margin: 4px 0 0">
										{formatDate(region.gtfsDownloadedAt)}
									</p>
								{/if}
								{#if region.feeds?.length}
									<button
										type="button"
										class="sys-mini"
										style="margin-top: 4px"
										aria-expanded={expandedRegions.includes(region.id)}
										onclick={() => toggleFeeds(region.id)}
									>
										{#if expandedRegions.includes(region.id)}
											<ChevronUp size={12} strokeWidth={2} aria-hidden="true" />
										{:else}
											<ChevronDown size={12} strokeWidth={2} aria-hidden="true" />
										{/if}
										{$t('admin.routingRegions.feedCount', {
											ready: String(
												region.feeds.filter(
													(feed) => feed.status !== 'error' && feed.status !== 'pending',
												).length,
											),
											total: String(region.feeds.length),
										})}
									</button>
									{#if expandedRegions.includes(region.id)}
										<ul
											class="sys-stack"
											style="gap: 4px; list-style: none; padding: 6px 0 0; margin: 0"
											transition:feedSlide={{ duration: 160 }}
										>
											{#each region.feeds as feed (feed.id)}
												<li
													class="sys-row-control"
													data-testid={`feed-${region.id}-${feed.id}`}
												>
													<span class={`sys-pill ${statusPill(feed.status)}`}>{feed.status}</span>
													<span class="sys-grow sys-truncate">{feed.name}</span>
													{#if feed.downloadedAt}
														<span class="sys-xs sys-muted">
															{formatDate(new Date(feed.downloadedAt).toISOString())}
														</span>
													{/if}
													{#if feed.bytes}
														<span class="sys-xs sys-muted">{formatSize(feed.bytes)}</span>
													{/if}
													<button
														type="button"
														class="sys-mini"
														onclick={() => void retryFeed(region.id, feed.id)}
														disabled={busyId === region.id}
													>
														{$t('admin.routingRegions.retryFeed')}
													</button>
													{#if feed.error}
														<p class="sys-error" style="flex-basis: 100%">{feed.error}</p>
													{/if}
												</li>
											{/each}
										</ul>
									{/if}
								{/if}
							</td>
							<td class="sys-xs sys-num">{formatSize(region.pbfSizeBytes)}</td>
							<td class="sys-xs sys-mono-text">{region.baseUrl ?? '—'}</td>
							<td class="sys-xs">{formatDate(region.lastUsedAt)}</td>
							<td>
								<span class="sys-row-control" style="justify-content: flex-end">
									{#if region.transitStatus !== 'none'}
										<button
											type="button"
											class="sys-mini"
											aria-label={$t('admin.routingRegions.refreshTransit')}
											title={$t('admin.routingRegions.refreshTransit')}
											onclick={() => void refreshTimetable(region.id)}
											disabled={busyId === region.id}
										>
											<RefreshCw size={12} strokeWidth={2} aria-hidden="true" />
										</button>
									{/if}
									{#if region.managed}
										{#if region.status === 'error' || (region.status === 'queued' && region.nextAttemptAt)}
											<button
												type="button"
												class="sys-mini"
												aria-label={$t('admin.routingRegions.retry')}
												title={$t('admin.routingRegions.retry')}
												onclick={() => void retry(region.id)}
												disabled={busyId === region.id}
											>
												<RotateCcw size={12} strokeWidth={2} aria-hidden="true" />
											</button>
										{/if}
										<button
											type="button"
											class="sys-mini sys-mini-danger"
											aria-label={$t('admin.routingRegions.remove')}
											title={$t('admin.routingRegions.remove')}
											onclick={() => (pendingRemove = region)}
											disabled={busyId === region.id}
										>
											<Trash2 size={12} strokeWidth={2} aria-hidden="true" />
										</button>
									{/if}
								</span>
							</td>
						</tr>
					{:else}
						<tr>
							<td colspan="9" class="sys-sm sys-muted">
								{$t('admin.routingRegions.empty')}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>

{#if pendingRemove}
	<ConfirmDialog
		title={$t('admin.system.removeRegion.title', { name: pendingRemove.name })}
		message={$t('admin.system.removeRegion.message')}
		confirmText={$t('admin.routingRegions.remove')}
		confirmVariant="danger"
		onConfirm={() => void remove(pendingRemove?.id ?? '')}
		onCancel={() => (pendingRemove = null)}
	/>
{/if}
