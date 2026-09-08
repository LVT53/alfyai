<script lang="ts">
import { onMount } from "svelte";
import { t } from "$lib/i18n";
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
	if (!confirm($t("admin.routingRegions.confirmRemove"))) return;
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
function feedClass(status: string): string {
	if (status === "ready") return "text-green-700 dark:text-green-300";
	if (status === "error") return "text-red-700 dark:text-red-300";
	return "text-amber-700 dark:text-amber-300";
}

function statusClass(status: string): string {
	if (status === "ready")
		return "bg-green-500/15 text-green-700 dark:text-green-300";
	if (status === "error") return "bg-red-500/15 text-red-700 dark:text-red-300";
	// "none" is not a problem — the region simply has no GTFS feed configured,
	// so it must not wear the amber "in progress" colour.
	if (status === "none") return "bg-surface-muted text-text-secondary";
	return "bg-amber-500/15 text-amber-700 dark:text-amber-300";
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

<section class="settings-card mb-4" data-testid="routing-regions-section">
	<div class="mb-2 flex items-center justify-between gap-3">
		<h2 class="settings-section-title mb-0">{$t('admin.routingRegions.title')}</h2>
		<button type="button" class="btn-secondary text-xs" onclick={() => void load()} disabled={loading}>
			{$t('admin.routingRegions.refresh')}
		</button>
	</div>
	<p class="mb-3 text-sm text-text-secondary">{$t('admin.routingRegions.description')}</p>

	{#if !configured}
		<p class="text-sm text-text-secondary">{$t('admin.routingRegions.notConfigured')}</p>
	{:else}
		<div class="mb-3 flex flex-wrap items-center gap-2">
			<input
				class="input-base w-64 text-sm"
				placeholder={$t('admin.routingRegions.idPlaceholder')}
				bind:value={newRegionId}
				onkeydown={(event) => {
					if (event.key === "Enter") void request();
				}}
			/>
			<button
				type="button"
				class="btn-primary text-xs"
				onclick={() => void request()}
				disabled={busyId !== null || !newRegionId.trim()}
			>
				{$t('admin.routingRegions.request')}
			</button>
			<a
				class="text-xs text-text-secondary underline"
				href="https://download.geofabrik.de/"
				target="_blank"
				rel="noreferrer"
			>
				{$t('admin.routingRegions.catalogue')}
			</a>
		</div>

		{#if error}
			<p class="mb-2 text-sm text-red-600" role="alert">{error}</p>
		{/if}
		{#if message}
			<p class="mb-2 text-sm text-text-secondary">{message}</p>
		{/if}

		<div class="overflow-x-auto">
			<table class="w-full text-left text-sm">
				<thead>
					<tr class="text-xs uppercase text-text-secondary">
						<th class="py-1 pr-3">{$t('admin.routingRegions.colRegion')}</th>
						<th class="py-1 pr-3">{$t('admin.routingRegions.colStatus')}</th>
						<th class="py-1 pr-3">{$t('admin.routingRegions.colResident')}</th>
						<th class="py-1 pr-3">{$t('admin.routingRegions.colGeocoder')}</th>
						<th class="py-1 pr-3">{$t('admin.routingRegions.colTransit')}</th>
						<th class="py-1 pr-3">{$t('admin.routingRegions.colSize')}</th>
						<th class="py-1 pr-3">{$t('admin.routingRegions.colEndpoint')}</th>
						<th class="py-1 pr-3">{$t('admin.routingRegions.colLastUsed')}</th>
						<th class="py-1"></th>
					</tr>
				</thead>
				<tbody>
					{#each regions as region (region.id)}
						<tr class="border-t border-border-subtle align-top">
							<td class="py-2 pr-3">
								<div class="font-medium">{region.name}</div>
								<div class="text-xs text-text-secondary">{region.id}{region.managed ? '' : ` · ${$t('admin.routingRegions.legacy')}`}</div>
								{#if region.error}
									<div class="mt-1 text-xs text-red-600">{region.error}</div>
								{/if}
							</td>
							<td class="py-2 pr-3">
								<span class={`rounded px-2 py-0.5 text-xs ${statusClass(region.status)}`}>{region.status}</span>
								{#if statusDetail(region)}
									<div class="mt-1 text-xs text-text-secondary">{statusDetail(region)}</div>
								{/if}
							</td>
							<td class="py-2 pr-3 text-xs">
								{#if region.managed}
									<label class="flex items-center gap-1">
										<input
											type="checkbox"
											checked={region.resident}
											disabled={busyId === region.id}
											onchange={() => void toggleResident(region)}
											aria-label={$t('admin.routingRegions.colResident')}
										/>
										<span class="sr-only">{$t('admin.routingRegions.colResident')}</span>
									</label>
								{:else}
									—
								{/if}
							</td>
							<td class="py-2 pr-3 text-xs">{region.geocoderStatus}</td>
							<td class="py-2 pr-3 text-xs" data-testid={`transit-${region.id}`}>
								<span class={`rounded px-2 py-0.5 ${statusClass(region.transitStatus)}`}>{region.transitStatus}</span>
								{#if region.gtfsDownloadedAt}
									<div class="mt-1 text-text-secondary">{formatDate(region.gtfsDownloadedAt)}</div>
								{/if}
								{#if region.feeds?.length}
									<details class="mt-1">
										<summary class="cursor-pointer text-text-secondary">
											{$t('admin.routingRegions.feedCount', {
												ready: String(region.feeds.filter((feed) => feed.status !== 'error' && feed.status !== 'pending').length),
												total: String(region.feeds.length),
											})}
										</summary>
										<ul class="mt-1 space-y-1">
											{#each region.feeds as feed (feed.id)}
												<li data-testid={`feed-${region.id}-${feed.id}`}>
													<span class={feedClass(feed.status)}>{feed.status}</span>
													<span class="ml-1">{feed.name}</span>
													{#if feed.downloadedAt}
														<span class="ml-1 text-text-secondary">{formatDate(new Date(feed.downloadedAt).toISOString())}</span>
													{/if}
													{#if feed.bytes}
														<span class="ml-1 text-text-secondary">{formatSize(feed.bytes)}</span>
													{/if}
													{#if feed.error}
														<div class="text-red-700 dark:text-red-300">{feed.error}</div>
													{/if}
													<button
														type="button"
														class="btn-secondary ml-1 text-xs"
														onclick={() => void retryFeed(region.id, feed.id)}
														disabled={busyId === region.id}
													>
														{$t('admin.routingRegions.retryFeed')}
													</button>
												</li>
											{/each}
										</ul>
									</details>
								{/if}
							</td>
							<td class="py-2 pr-3 text-xs">{formatSize(region.pbfSizeBytes)}</td>
							<td class="py-2 pr-3 text-xs">{region.baseUrl ?? '—'}</td>
							<td class="py-2 pr-3 text-xs">{formatDate(region.lastUsedAt)}</td>
							<td class="py-2 text-right whitespace-nowrap">
								{#if region.transitStatus !== 'none'}
									<button
										type="button"
										class="btn-secondary text-xs"
										onclick={() => void refreshTimetable(region.id)}
										disabled={busyId === region.id}
									>
										{$t('admin.routingRegions.refreshTransit')}
									</button>
								{/if}
								{#if region.managed}
									{#if region.status === 'error' || (region.status === 'queued' && region.nextAttemptAt)}
										<button type="button" class="btn-secondary text-xs" onclick={() => void retry(region.id)} disabled={busyId === region.id}>
											{$t('admin.routingRegions.retry')}
										</button>
									{/if}
									<button type="button" class="btn-secondary ml-1 text-xs" onclick={() => void remove(region.id)} disabled={busyId === region.id}>
										{$t('admin.routingRegions.remove')}
									</button>
								{/if}
							</td>
						</tr>
					{:else}
						<tr><td colspan="9" class="py-2 text-sm text-text-secondary">{$t('admin.routingRegions.empty')}</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>
