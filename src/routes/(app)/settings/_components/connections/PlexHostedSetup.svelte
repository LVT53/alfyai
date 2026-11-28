<script lang="ts">
import { onDestroy } from "svelte";
import { ExternalLink, Server } from "@lucide/svelte";
import {
	startPlexLink,
	pollPlexLink,
	selectPlexServer,
} from "$lib/client/api/connections";
import { ApiError } from "$lib/client/api/http";
import { t, type I18nKey } from "$lib/i18n";
import { showToast } from "$lib/stores/toast";

let {
	connectionId,
	onConnected,
	onClose,
	onManual,
}: {
	connectionId: string | null;
	onConnected: () => void;
	onClose: () => void;
	onManual: () => void;
} = $props();
type Choice = { id: string; name: string };
const lifetime = new AbortController();
let attemptId = "";
let authUrl = $state("");
let servers = $state<Choice[] | null>(null);
let selected = $state<Choice | null>(null);
let busy = $state(false);
let checking = $state(false);
let failure = $state<I18nKey | null>(null);
let timer: ReturnType<typeof setTimeout>;
let popup: Window | null = null;

function closePopup() {
	popup?.close();
	popup = null;
}

onDestroy(() => {
	lifetime.abort();
	clearTimeout(timer);
	closePopup();
});

function expired() {
	closePopup();
	attemptId = "";
	authUrl = "";
	servers = null;
	selected = null;
	failure = "connections.wizard.plex.expired";
}

async function connect(server: Choice) {
	selected = server;
	busy = true;
	failure = null;
	try {
		await selectPlexServer(attemptId, server.id, lifetime.signal);
		if (lifetime.signal.aborted) return;
		showToast({
			type: "success",
			message: $t("connections.wizard.plex.connected", { name: server.name }),
		});
		onConnected();
		onClose();
	} catch (err) {
		if (lifetime.signal.aborted) return;
		if (err instanceof ApiError && err.status === 410) expired();
		else if (err instanceof ApiError && err.status === 403)
			failure = "connections.wizard.plex.noGrant";
		else if (err instanceof ApiError && err.status === 429)
			failure = "connections.wizard.plex.busy";
		else if (err instanceof ApiError && err.status === 422)
			failure = "connections.wizard.plex.unreachable";
		else failure = "connections.wizard.plex.selectError";
	} finally {
		busy = false;
	}
}

async function ready(choices: Choice[]) {
	closePopup();
	authUrl = "";
	servers = choices;
	const previous = selected;
	selected = null;
	if (choices.length === 1 && (!previous || choices[0].id === previous.id))
		await connect(choices[0]);
}

async function check() {
	if (checking || !attemptId || busy || lifetime.signal.aborted) return;
	clearTimeout(timer);
	checking = true;
	failure = null;
	try {
		const result = await pollPlexLink(attemptId, lifetime.signal);
		if (lifetime.signal.aborted) return;
		if (result.status === "ready") await ready(result.servers);
		else if (result.status === "expired") expired();
		else timer = setTimeout(check, 2500);
	} catch (err) {
		if (lifetime.signal.aborted) return;
		if (err instanceof ApiError && err.status === 410) expired();
		else if (err instanceof ApiError && err.status === 429)
			timer = setTimeout(check, 10000);
		else failure = "connections.wizard.plex.discoveryError";
	} finally {
		checking = false;
	}
}

async function begin() {
	if (busy) return;
	busy = true;
	failure = null;
	// Open in the click handler while the browser still has user activation.
	// Remove the opener before navigating outside AlfyAI.
	try {
		popup = window.open("about:blank", "_blank");
		if (popup) popup.opener = null;
	} catch {
		// Browsers may throw instead of returning null when popups are blocked.
		closePopup();
	}
	try {
		const result = await startPlexLink(connectionId, lifetime.signal);
		if (lifetime.signal.aborted) return;
		attemptId = result.attemptId;
		if ("servers" in result) {
			await ready(result.servers);
			return;
		}
		const url = new URL(result.authUrl);
		if (url.origin !== "https://app.plex.tv" || url.username || url.password)
			throw Error("Invalid Plex sign-in URL");
		authUrl = url.href;
		popup?.location.replace(authUrl);
	} catch (err) {
		if (lifetime.signal.aborted) return;
		if (err instanceof ApiError && err.status === 410) {
			expired();
			return;
		}
		closePopup();
		authUrl = "";
		attemptId = "";
		failure =
			err instanceof ApiError && err.status === 429
				? "connections.wizard.plex.busy"
				: "connections.wizard.plex.startError";
	} finally {
		busy = false;
	}
	if (authUrl) void check();
}
</script>

<svelte:window onfocus={() => {if (authUrl) void check();}} />

<div class="plex-setup">
	{#if failure}
		<p role="alert">{$t(failure, {name: selected?.name ?? ""})}</p>
	{/if}
	{#if servers !== null}
		{#if selected && busy}
			<p role="status">{$t("connections.wizard.plex.connecting", {name:selected.name})}</p>
		{:else if selected && failure}
			{#if failure === "connections.wizard.plex.noGrant"}
				<button type="button" class="btn-primary" disabled={checking} onclick={check}>{$t("connections.wizard.plex.refresh")}</button>
			{:else}
				<button type="button" class="btn-primary" onclick={() => selected && connect(selected)}>{$t("connections.wizard.plex.retry")}</button>
			{/if}
			{#if servers.length > 1}
				<button type="button" class="btn-secondary" onclick={() => {selected = null; failure = null;}}>{$t("connections.wizard.plex.another")}</button>
			{/if}
		{:else if !servers.length}
			<p>{$t("connections.wizard.plex.noServers")}</p>
			<button type="button" class="btn-secondary" onclick={check}>{$t("connections.wizard.plex.refresh")}</button>
		{:else}
			<h3>{$t("connections.wizard.plex.choose")}</h3>
			{#each servers as server (server.id)}
				<button type="button" class="btn-secondary server" disabled={checking || busy} onclick={() => connect(server)}><Server size={16} aria-hidden="true"/>{server.name}</button>
			{/each}
		{/if}
	{:else if authUrl}
		<p role="status">{$t("connections.wizard.plex.waiting")}</p>
		<a href={authUrl} target="_blank" rel="noopener noreferrer" class="btn-secondary">{$t("connections.wizard.plex.open")} <ExternalLink size={14} aria-hidden="true"/></a>
		{#if failure}<button type="button" class="btn-secondary" onclick={check}>{$t("common.retry")}</button>{/if}
	{:else}
		<button type="button" class="btn-primary" disabled={busy} onclick={begin}>{$t(busy ? "common.loading" : "connections.wizard.plex.start")}</button>
		<button type="button" class="manual" disabled={busy} onclick={onManual}>{$t("connections.wizard.plex.manual")}</button>
	{/if}
	<div class="foot"><button type="button" class="btn-secondary" onclick={onClose}>{$t("common.cancel")}</button></div>
</div>

<style>
	.plex-setup { display: grid; gap: var(--space-sm); }
	h3, p { margin: 0; }
	h3 { font-size: 1rem; }
	p, .manual { font-size: .875rem; color: var(--text-secondary); }
	.manual { justify-self: start; text-decoration: underline; text-underline-offset: .16em; }
	.server { justify-content: flex-start; overflow-wrap: anywhere; }
	.foot { display: flex; justify-content: flex-end; margin-top: var(--space-sm); }
	[role="alert"] { color: var(--danger); }
</style>
