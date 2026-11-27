<script lang="ts">
import { Copy, ExternalLink } from "@lucide/svelte";
import { onMount, type Snippet } from "svelte";
import {
	fetchHostedBoschSetup,
	startHostedBoschSetup,
	updateHostedBoschGrants,
} from "$lib/client/api/connections";
import BoschSetupSteps from "$lib/components/guide/BoschSetupSteps.svelte";
import { t, type I18nKey } from "$lib/i18n";
import type { BoschHostedGrant } from "$lib/shared/bosch-hosted";
import PasswordField from "../PasswordField.svelte";

let {
	redirectTo,
	onSaved,
	legacy,
}: { redirectTo: (url: string) => void; onSaved: () => void; legacy: Snippet } =
	$props();
const groups = ["details", "fitness", "location"] as const;
let setup = $state<Awaited<ReturnType<typeof fetchHostedBoschSetup>> | null>(
	null,
);
let grants = $state<BoschHostedGrant[]>([]);
let authorize = $state(false);
let busy = $state(false);
let failure = $state<I18nKey | null>(null);
let clientId = $state("");
let confidential = $state(false);
let clientSecret = $state("");
let shown = $state(false);
let copied = $state("");
let copyFailed = $state(false);
const lifetime = new AbortController();

async function load() {
	failure = null;
	try {
		const info = await fetchHostedBoschSetup(lifetime.signal);
		if (lifetime.signal.aborted) return;
		setup = info;
		grants = [...info.grants];
		authorize = info.mode === "none";
	} catch {
		if (!lifetime.signal.aborted) failure = "connections.wizard.bosch.loadFail";
	}
}
onMount(() => {
	void load();
	return () => lifetime.abort();
});
async function copyAddress(id: string) {
	const input = document.getElementById(id);
	if (!(input instanceof HTMLInputElement)) return;
	copied = "";
	copyFailed = false;
	try {
		await navigator.clipboard.writeText(input.value);
		copied = input.id;
	} catch {
		input.focus();
		input.select();
		copyFailed = true;
	}
}
async function submit(event: SubmitEvent) {
	event.preventDefault();
	if (busy || !setup) return;
	failure = null;
	busy = true;
	try {
		if (authorize) {
			const { authUrl } = await startHostedBoschSetup(
				{
					clientId: clientId.trim(),
					...(confidential ? { clientSecret: clientSecret.trim() } : {}),
					grants: [...grants],
				},
				lifetime.signal,
			);
			if (!lifetime.signal.aborted) redirectTo(authUrl);
		} else {
			await updateHostedBoschGrants([...grants], lifetime.signal);
			if (!lifetime.signal.aborted) onSaved();
		}
	} catch {
		if (!lifetime.signal.aborted)
			failure = authorize
				? "connections.wizard.bosch.submitFail"
				: "connections.wizard.bosch.saveFail";
	} finally {
		busy = false;
	}
}
</script>

{#snippet address(id: string, label: string, value: string)}
	<div>
		<label for={id} class="settings-label">{label}</label>
		<div class="address">
			<input {id} class="settings-input" readonly {value} onclick={(event) => event.currentTarget.select()} />
			<button type="button" class="btn-secondary" aria-label={`${$t("connections.wizard.bosch.copy")} ${label}`} onclick={() => copyAddress(id)}>
				<Copy size={14} aria-hidden="true" />
				<span aria-live="polite">{copied === id ? $t("connections.wizard.bosch.copied") : $t("connections.wizard.bosch.copy")}</span>
			</button>
		</div>
	</div>
{/snippet}

{#if !setup}
	{#if failure}
		<p role="alert">{$t(failure)}</p>
		<button type="button" class="btn-secondary" onclick={load}>{$t("common.retry")}</button>
	{:else}
		<p role="status">{$t("common.loading")}</p>
	{/if}
{:else if setup.mode === "helper" && !authorize}
	<div class="section">
		<p>{$t("connections.wizard.bosch.legacy")}</p>
		<button type="button" class="btn-primary" onclick={() => authorize = true}>{$t("connections.wizard.bosch.migrate")}</button>
	</div>
{:else}
	<form onsubmit={submit} class="setup-form">
		{#if authorize}
			<section class="section">
				<h3>{$t("connections.wizard.bosch.registration")}</h3>
				<p>{$t("connections.wizard.bosch.registrationHint")}</p>
				<a class="portal" href="https://portal.bosch-ebike.com/data-act" target="_blank" rel="noopener noreferrer">Bosch Partner Portal <ExternalLink size={13} aria-hidden="true" />
				</a>
				{@render address("bosch-login-url", "Login URL", new URL("/settings?section=connections", setup.callbackUrl).href)}
				{@render address("bosch-redirect-uri", "Redirect URI", setup.callbackUrl)}
				{#if copyFailed}<p role="status">{$t("connections.wizard.bosch.copyFail")}</p>{/if}
				<BoschSetupSteps/>
				<div>
					<label for="bosch-client-id" class="settings-label">{$t("connections.wizard.bosch.clientId")}</label>
					<input id="bosch-client-id" class="settings-input" required bind:value={clientId} autocomplete="off" spellcheck={false}/>
				</div>
				<label class="check"><input type="checkbox" bind:checked={confidential}/>{$t("connections.wizard.bosch.confidential")}</label>
				{#if confidential}
					<PasswordField id="bosch-client-secret" label={$t("connections.wizard.bosch.secret")} bind:value={clientSecret} bind:shown autocomplete="off"/>
				{/if}
			</section>
		{/if}
		<fieldset class="section">
			<legend>{$t("connections.wizard.bosch.permissions")}</legend>
			<p>{$t("connections.wizard.bosch.base")}</p>
			<button type="button" class="btn-secondary" disabled={grants.length === groups.length} onclick={() => grants = [...groups]}>{$t("connections.wizard.bosch.allowAll")}</button>
			{#each groups as group (group)}
				<div class="grant">
					<label class="check"><input type="checkbox" bind:group={grants} value={group} aria-describedby={`bosch-${group}-hint`}/>{$t(`connections.wizard.bosch.${group}`)}</label>
					<p id={`bosch-${group}-hint`}>{$t(`connections.wizard.bosch.${group}Hint`)}</p>
				</div>
			{/each}
		</fieldset>
		<div class="section">
			<p>{$t("connections.wizard.bosch.bikeReminder")}</p>
			<a class="portal" href="https://flow.bosch-ebike.com/data-act" target="_blank" rel="noopener noreferrer">Bosch Flow <ExternalLink size={13} aria-hidden="true" />
				</a>
		</div>
		{#if failure}<p role="alert">{$t(failure)}</p>{/if}
		<div class="actions">
			{#if !authorize}
				<button type="button" class="btn-secondary" disabled={busy} onclick={() => authorize = true}>{$t("connections.wizard.bosch.authorizeAgain")}</button>
			{/if}
			<button type="submit" class="btn-primary" disabled={busy || (authorize && (!clientId.trim() || (confidential && !clientSecret.trim())))}>{busy ? $t("common.loading") : authorize ? $t("connections.wizard.bosch.signin") : $t("common.save")}</button>
		</div>
	</form>
{/if}
{#if setup && setup.mode !== "hosted"}
	<details class="legacy">
		<summary>{$t("connections.wizard.bosch.selfHost")}</summary>
		{@render legacy()}
	</details>
{/if}

<style>
	.setup-form,.section,.legacy[open] { display:grid; gap:var(--space-md); }
	.setup-form { gap:var(--space-lg); }
	.section { min-width:0; justify-items:start; }
	.section > div:not(.grant) { width:100%; }
	fieldset { border:0; margin:0; padding:0; }
	h3,legend { font-size:1rem; font-weight:600; }
	legend { margin-bottom:var(--space-sm); }
	p { font-size:.875rem; line-height:1.5; color:var(--text-secondary); }
	.address,.actions,.check,.portal { display:flex; align-items:center; gap:var(--space-sm); }
	.address input { min-width:0; flex:1; }
	.address button { display:flex; align-items:center; gap:.35rem; }
	.actions { justify-content:flex-end; flex-wrap:wrap; }
	.check { font-size:.875rem; cursor:pointer; }
	.grant p { margin-inline-start:1.5rem; }
	.portal { text-decoration:underline; text-underline-offset:.15em; font-size:.875rem; }
	.legacy { margin-top:var(--space-lg); border-top:1px solid var(--border-default); padding-top:var(--space-md); font-size:.875rem; }
	summary { cursor:pointer; color:var(--text-secondary); }
</style>
