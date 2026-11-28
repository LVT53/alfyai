<script lang="ts">
import { onMount } from "svelte";
import {
	fetchBoschBikeNames,
	saveBoschBikeName,
} from "$lib/client/api/connections";
import { t } from "$lib/i18n";

type BikeRow = {
	id: string;
	saved: string;
	draft: string;
	status: "idle" | "saving" | "saved" | "error";
};
let bikes = $state<BikeRow[] | null>(null);
let failed = $state(false);
const lifetime = new AbortController();

let loading = false;
let saveVersion = 0;

async function load() {
	if (
		loading ||
		document.visibilityState === "hidden" ||
		bikes?.some((bike) => bike.status === "saving")
	)
		return;
	loading = true;
	const version = saveVersion;
	try {
		const result = await fetchBoschBikeNames(lifetime.signal);
		if (lifetime.signal.aborted || version !== saveVersion) return;
		const existing = new Map(bikes?.map((row) => [row.id, row]));
		bikes = result.bikes.map(({ id, name }): BikeRow => {
			const row = existing.get(id);
			const saved = name ?? "";
			if (!row) return { id, saved, draft: saved, status: "idle" };
			if (row.draft === row.saved && saved !== row.saved) {
				row.draft = saved;
				row.status = "idle";
			}
			row.saved = saved;
			return row;
		});
		failed = false;
	} catch {
		if (!lifetime.signal.aborted) failed = true;
	} finally {
		loading = false;
	}
}

onMount(() => {
	void load();
	const interval = window.setInterval(load, 30_000);
	window.addEventListener("focus", load);
	document.addEventListener("visibilitychange", load);
	return () => {
		window.clearInterval(interval);
		window.removeEventListener("focus", load);
		document.removeEventListener("visibilitychange", load);
		lifetime.abort();
	};
});

async function save(event: SubmitEvent, bike: BikeRow) {
	event.preventDefault();
	const name = bike.draft.trim();
	if (bike.status === "saving" || bike.saved === name) return;
	saveVersion++;
	bike.status = "saving";
	try {
		await saveBoschBikeName(bike.id, name, lifetime.signal);
		if (lifetime.signal.aborted) return;
		bike.saved = name;
		bike.draft = name;
		bike.status = "saved";
	} catch {
		if (!lifetime.signal.aborted) bike.status = "error";
	}
}
</script>

<div class="bike-names">
	{#if failed}
		<p role="alert">{$t("connections.bosch.bikesLoadFail")}</p>
		<button type="button" class="btn-secondary" onclick={load}>{$t("common.retry")}</button>
	{/if}
	{#if bikes === null && !failed}
		<p role="status">{$t("common.loading")}</p>
	{:else if bikes?.length === 0 && !failed}
		<p>{$t("connections.bosch.bikesEmpty")}</p>
	{:else if bikes?.length}
		<p>{$t("connections.bosch.bikesHint")}</p>
		{#each bikes as bike, index (bike.id)}
			<form aria-labelledby={`bosch-bike-label-${index}`} onsubmit={(event) => save(event, bike)}>
				<label class="settings-label" id={`bosch-bike-label-${index}`} for={`bosch-bike-name-${index}`}>{$t("connections.bosch.bikeLabel", { id: bike.id })}</label>
				<div class="name-row">
					<input id={`bosch-bike-name-${index}`} class="settings-input" maxlength="80" bind:value={bike.draft} oninput={() => bike.status = "idle"} disabled={bike.status === "saving"} />
					<button class="btn-secondary" type="submit" disabled={bike.status === "saving" || bike.draft.trim() === bike.saved}>
						{bike.status === "saving" ? $t("common.loading") : $t("common.save")}
					</button>
				</div>
				{#if bike.status === "error"}<p role="alert">{$t("connections.bosch.nameSaveFail")}</p>
				{:else if bike.status === "saved"}<p role="status">{$t("connections.bosch.nameSaved")}</p>{/if}
			</form>
		{/each}
	{/if}
</div>

<style>
	.bike-names, form { display: grid; gap: var(--space-sm); min-width: 0; }
	.bike-names > button { justify-self: start; }
	.name-row { display: flex; align-items: center; gap: var(--space-sm); }
	input { min-width: 0; flex: 1; }
	label { overflow-wrap: anywhere; }
	p { color: var(--text-secondary); font-size: .8125rem; line-height: 1.45; }
	p[role="alert"] { color: var(--danger); }
</style>
