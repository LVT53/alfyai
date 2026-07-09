<script lang="ts">
// Issue 7.3 — the connect/reconnect wizard opened from the Connections panel
// (SettingsConnectionsTab's onStartConnect/onReconnect -> +page.svelte's
// connectWizardProvider/reconnectConnectionId intent state). One form per
// `connectMethod` (see provider-catalog.ts), plus a special case for
// OwnTracks (catalog-labelled "password-key" but actually a device picker —
// see the `kind` derivation below) and for "contacts" (catalog entry exists
// but has no backend start route yet, so it shows a "not available" notice).
//
// The parent always mounts this component conditionally on `provider` being
// non-null (`{#if connectWizardProvider}<ConnectWizardModal .../>{/if}`), so
// every open is a fresh component instance — no need to reset form state on
// prop changes mid-lifetime.
import { onDestroy, onMount, untrack } from "svelte";
import { t } from "$lib/i18n";
import DialogShell from "$lib/components/ui/DialogShell.svelte";
import PasswordField from "./PasswordField.svelte";
import {
	type ConnectionPublic,
	fetchOwnTracksDevices,
	type OwnTracksDevice,
	pollNextcloudConnect,
	startAppleConnect,
	startEmailConnect,
	startGoogleConnect,
	startImmichConnect,
	startNextcloudConnect,
	startOwnTracksConnect,
	startPlexConnect,
} from "$lib/client/api/connections";
import { ApiError } from "$lib/client/api/http";
import {
	type Capability,
	type ConnectionProvider,
	getProviderCatalogEntry,
} from "$lib/client/connections/provider-catalog";

let {
	provider,
	reconnectConnectionId = null,
	reconnectConnection = null,
	onClose,
	onConnected,
	// Indirections around browser navigation APIs so tests can assert on
	// them without a hard `window.location`/`window.open` reference.
	redirectTo = (url: string) => {
		window.location.href = url;
	},
	openWindow = (url: string) => {
		window.open(url, "_blank", "noopener");
	},
	pollIntervalMs = 2000,
	pollTimeoutMs = 3 * 60 * 1000,
}: {
	provider: ConnectionProvider | null;
	reconnectConnectionId?: string | null;
	reconnectConnection?: ConnectionPublic | null;
	onClose: () => void;
	onConnected: () => void;
	redirectTo?: (url: string) => void;
	openWindow?: (url: string) => void;
	pollIntervalMs?: number;
	pollTimeoutMs?: number;
} = $props();

// `provider`/`reconnectConnectionId`/`reconnectConnection` never change
// across this instance's lifetime (see note above: the parent always
// destroys and recreates the component on open/close), so everything below
// intentionally takes a ONE-TIME snapshot rather than staying reactive —
// re-syncing form fields to a live prop on every change is not what we want
// (it would clobber in-progress user edits). `untrack()` tells Svelte this
// is deliberate and silences the "only captures the initial value" warning
// that would otherwise assume a bug (mirrors the $state(untrack(() => ...))
// seeding pattern in ModelForm.svelte).
const initialProvider = untrack(() => provider);
const initialReconnectConnectionId = untrack(() => reconnectConnectionId);
const initialReconnectConnection = untrack(() => reconnectConnection);

const providerEntry = initialProvider
	? getProviderCatalogEntry(initialProvider)
	: null;
const isReconnect = !!initialReconnectConnectionId;

type Kind =
	| "oauth"
	| "login-flow-v2"
	| "password-key"
	| "app-password"
	| "owntracks"
	| "unavailable";

const kind: Kind | null = !initialProvider
	? null
	: initialProvider === "owntracks"
		? "owntracks"
		: initialProvider === "contacts"
			? "unavailable"
			: (providerEntry?.connectMethod ?? null);

function reconnectConfigString(key: string): string {
	const value = initialReconnectConnection?.config?.[key];
	return typeof value === "string" ? value : "";
}

function reconnectConfigNumber(key: string): number | undefined {
	const value = initialReconnectConnection?.config?.[key];
	return typeof value === "number" ? value : undefined;
}

function reconnectConfigBoolean(key: string, fallback: boolean): boolean {
	const value = initialReconnectConnection?.config?.[key];
	return typeof value === "boolean" ? value : fallback;
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

let submitting = $state(false);
let errorText = $state("");

// --- oauth (Google) ---------------------------------------------------
let selectedCapabilities = $state<Set<Capability>>(
	new Set(providerEntry?.capabilities ?? []),
);
let googleNotConfigured = $state(false);

function toggleCapability(capability: Capability) {
	const next = new Set(selectedCapabilities);
	if (next.has(capability)) next.delete(capability);
	else next.add(capability);
	selectedCapabilities = next;
}

async function submitGoogle() {
	if (submitting || selectedCapabilities.size === 0) return;
	submitting = true;
	errorText = "";
	googleNotConfigured = false;
	try {
		const { authUrl } = await startGoogleConnect([...selectedCapabilities]);
		redirectTo(authUrl);
	} catch (err) {
		if (err instanceof ApiError && err.status === 501) {
			googleNotConfigured = true;
		} else {
			errorText = errMessage(err);
		}
	} finally {
		submitting = false;
	}
}

// --- login-flow-v2 (Nextcloud) -----------------------------------------
let ncServerUrl = $state(reconnectConfigString("serverUrl"));
let ncPhase = $state<"form" | "waiting" | "timeout">("form");
let ncPollToken = "";
let ncPollServerUrl = "";
let ncElapsedMs = 0;
let ncTimer: ReturnType<typeof setTimeout> | null = null;

async function submitNextcloud(event: Event) {
	event.preventDefault();
	if (submitting) return;
	const serverUrl = ncServerUrl.trim();
	if (!serverUrl) return;
	submitting = true;
	errorText = "";
	try {
		const result = await startNextcloudConnect(serverUrl);
		ncPollToken = result.pollToken;
		ncPollServerUrl = result.serverUrl;
		openWindow(result.loginUrl);
		ncPhase = "waiting";
		ncElapsedMs = 0;
		scheduleNextPoll();
	} catch (err) {
		errorText = errMessage(err);
	} finally {
		submitting = false;
	}
}

function scheduleNextPoll() {
	ncTimer = setTimeout(() => {
		void pollOnce();
	}, pollIntervalMs);
}

async function pollOnce() {
	if (ncPhase !== "waiting") return;
	try {
		const result = await pollNextcloudConnect({
			serverUrl: ncPollServerUrl,
			pollToken: ncPollToken,
		});
		if (result.status === "connected") {
			onConnected();
			onClose();
			return;
		}
	} catch (err) {
		errorText = errMessage(err);
		ncPhase = "form";
		return;
	}
	ncElapsedMs += pollIntervalMs;
	if (ncElapsedMs >= pollTimeoutMs) {
		ncPhase = "timeout";
		return;
	}
	scheduleNextPoll();
}

function manualRecheck() {
	if (ncTimer) {
		clearTimeout(ncTimer);
		ncTimer = null;
	}
	void pollOnce();
}

function cancelNextcloudWait() {
	if (ncTimer) {
		clearTimeout(ncTimer);
		ncTimer = null;
	}
	onClose();
}

function retryNextcloud() {
	ncPhase = "form";
	errorText = "";
}

onDestroy(() => {
	if (ncTimer) clearTimeout(ncTimer);
});

// --- password-key (Immich) ----------------------------------------------
// Immich stores the normalized server URL under config.origin and the
// login email as the connection's accountIdentifier (see immichConnect in
// src/lib/server/services/connections/providers/immich.ts) — NOT
// config.serverUrl/config.email, which don't exist on this provider.
let immichServerUrl = $state(reconnectConfigString("origin"));
let immichEmail = $state(initialReconnectConnection?.accountIdentifier ?? "");
let immichPassword = $state("");
let immichShowPassword = $state(false);

async function submitImmich(event: Event) {
	event.preventDefault();
	if (submitting) return;
	submitting = true;
	errorText = "";
	try {
		await startImmichConnect({
			serverUrl: immichServerUrl.trim(),
			email: immichEmail.trim(),
			password: immichPassword,
		});
		onConnected();
		onClose();
	} catch (err) {
		errorText = errMessage(err);
	} finally {
		submitting = false;
	}
}

// --- password-key (Plex) -------------------------------------------------
// Plex stores the normalized server URL under config.origin (see
// plexConnect in src/lib/server/services/connections/providers/plex.ts) —
// the token itself is never persisted in plaintext, so it can't be
// prefilled on reconnect.
let plexServerUrl = $state(reconnectConfigString("origin"));
let plexToken = $state("");
let plexShowToken = $state(false);

async function submitPlex(event: Event) {
	event.preventDefault();
	if (submitting) return;
	submitting = true;
	errorText = "";
	try {
		await startPlexConnect({
			serverUrl: plexServerUrl.trim(),
			token: plexToken.trim(),
		});
		onConnected();
		onClose();
	} catch (err) {
		errorText = errMessage(err);
	} finally {
		submitting = false;
	}
}

// --- app-password (Apple) -------------------------------------------------
let appleId = $state(
	reconnectConfigString("appleId") ||
		(initialReconnectConnection?.accountIdentifier ?? ""),
);
let appleAppPassword = $state("");
let appleShowPassword = $state(false);

async function submitApple(event: Event) {
	event.preventDefault();
	if (submitting) return;
	submitting = true;
	errorText = "";
	try {
		await startAppleConnect({
			appleId: appleId.trim(),
			appPassword: appleAppPassword.trim(),
		});
		onConnected();
		onClose();
	} catch (err) {
		errorText = errMessage(err);
	} finally {
		submitting = false;
	}
}

// --- app-password (Email / IMAP) ------------------------------------------
let emailAddress = $state(initialReconnectConnection?.accountIdentifier ?? "");
let imapHost = $state(reconnectConfigString("imapHost"));
let imapPort = $state<number | "">(reconnectConfigNumber("imapPort") ?? 993);
let imapSecure = $state<boolean>(reconnectConfigBoolean("imapSecure", true));
let emailPassword = $state("");
let emailShowPassword = $state(false);
let smtpHost = $state(reconnectConfigString("smtpHost"));
let smtpPort = $state<number | "">(reconnectConfigNumber("smtpPort") ?? "");

async function submitEmail(event: Event) {
	event.preventDefault();
	if (submitting) return;
	submitting = true;
	errorText = "";
	try {
		await startEmailConnect({
			email: emailAddress.trim(),
			imapHost: imapHost.trim(),
			...(imapPort !== "" ? { imapPort } : {}),
			imapSecure,
			password: emailPassword,
			...(smtpHost.trim() ? { smtpHost: smtpHost.trim() } : {}),
			...(smtpPort !== "" ? { smtpPort } : {}),
		});
		onConnected();
		onClose();
	} catch (err) {
		errorText = errMessage(err);
	} finally {
		submitting = false;
	}
}

// --- OwnTracks device picker -----------------------------------------------
let otLoading = $state(false);
let otLoadError = $state("");
let otNotConfigured = $state(false);
let otDevices = $state<OwnTracksDevice[]>([]);
let otSelectedKey = $state<string | null>(null);

function deviceKey(device: OwnTracksDevice): string {
	return `${device.otUser}::${device.otDevice}`;
}

async function loadOwnTracksDevices() {
	otLoading = true;
	otLoadError = "";
	otNotConfigured = false;
	try {
		otDevices = await fetchOwnTracksDevices();
	} catch (err) {
		if (err instanceof ApiError && err.status === 409) {
			otNotConfigured = true;
		} else {
			otLoadError = errMessage(err);
		}
	} finally {
		otLoading = false;
	}
}

async function submitOwnTracks(event: Event) {
	event.preventDefault();
	if (submitting || !otSelectedKey) return;
	const selected = otDevices.find((d) => deviceKey(d) === otSelectedKey);
	if (!selected) return;
	submitting = true;
	errorText = "";
	try {
		await startOwnTracksConnect({
			otUser: selected.otUser,
			otDevice: selected.otDevice,
		});
		onConnected();
		onClose();
	} catch (err) {
		errorText = errMessage(err);
	} finally {
		submitting = false;
	}
}

onMount(() => {
	if (kind === "owntracks") void loadOwnTracksDevices();
});
</script>

{#if initialProvider && providerEntry && kind}
	<DialogShell
		title={isReconnect
			? $t('connections.wizard.titleReconnect', { provider: providerEntry.displayName })
			: $t('connections.wizard.titleConnect', { provider: providerEntry.displayName })}
		onClose={onClose}
		maxWidthClass="max-w-[32rem]"
		zIndexClass="z-[9999]"
	>
		<div class="max-h-[calc(100vh-2rem)] overflow-y-auto">
			{#if kind === 'unavailable'}
				<p class="text-sm text-text-secondary">{$t('connections.wizard.contacts.notAvailable')}</p>
				<div class="mt-6 flex justify-end">
					<button type="button" class="btn-secondary" onclick={onClose}>{$t('common.close')}</button>
				</div>
			{:else if kind === 'oauth'}
				<p class="mb-4 text-sm text-text-secondary">{$t('connections.wizard.oauth.intro')}</p>
				{#if googleNotConfigured}
					<p class="mb-4 text-sm text-danger">{$t('connections.wizard.oauth.notConfigured')}</p>
				{:else}
					<fieldset class="flex flex-col gap-2">
						<legend class="settings-label mb-1">{$t('connections.capabilities.label')}</legend>
						{#each providerEntry.capabilities as capability}
							<label class="flex items-center gap-2 text-sm text-text-primary">
								<input
									type="checkbox"
									checked={selectedCapabilities.has(capability)}
									onchange={() => toggleCapability(capability)}
								/>
								{$t(`connections.capability.${capability}` as Parameters<typeof $t>[0])}
							</label>
						{/each}
					</fieldset>
					{#if selectedCapabilities.size === 0}
						<p class="mt-2 text-sm text-danger">{$t('connections.wizard.selectAtLeastOne')}</p>
					{/if}
				{/if}
				{#if errorText}
					<p class="mt-3 text-sm text-danger">{errorText}</p>
				{/if}
				<div class="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
					<button type="button" class="btn-secondary w-full sm:w-auto" onclick={onClose}>{$t('common.cancel')}</button>
					{#if !googleNotConfigured}
						<button
							type="button"
							class="btn-primary w-full whitespace-nowrap sm:w-auto"
							disabled={submitting || selectedCapabilities.size === 0}
							onclick={submitGoogle}
						>
							{submitting ? $t('connections.wizard.oauth.redirecting') : $t('connections.wizard.oauth.continue')}
						</button>
					{/if}
				</div>
			{:else if kind === 'login-flow-v2'}
				{#if ncPhase === 'form'}
					<form onsubmit={submitNextcloud}>
						<p class="mb-3 text-sm text-text-secondary">{$t('connections.wizard.nextcloud.help')}</p>
						<label class="settings-label" for="wizard-nextcloud-server-url">{$t('connections.wizard.nextcloud.serverUrlLabel')}</label>
						<input
							id="wizard-nextcloud-server-url"
							type="url"
							class="settings-input"
							bind:value={ncServerUrl}
							placeholder={$t('connections.wizard.nextcloud.serverUrlPlaceholder')}
						/>
						{#if errorText}
							<p class="mt-3 text-sm text-danger">{errorText}</p>
						{/if}
						<div class="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
							<button type="button" class="btn-secondary w-full sm:w-auto" onclick={onClose}>{$t('common.cancel')}</button>
							<button type="submit" class="btn-primary w-full whitespace-nowrap sm:w-auto" disabled={submitting || !ncServerUrl.trim()}>
								{submitting ? $t('connections.wizard.connecting') : $t('connections.actions.connect')}
							</button>
						</div>
					</form>
				{:else if ncPhase === 'waiting'}
					<p class="text-sm text-text-secondary">{$t('connections.wizard.nextcloud.waiting')}</p>
					{#if errorText}
						<p class="mt-3 text-sm text-danger">{errorText}</p>
					{/if}
					<div class="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
						<button type="button" class="btn-secondary w-full sm:w-auto" onclick={cancelNextcloudWait}>{$t('common.cancel')}</button>
						<button type="button" class="btn-primary w-full whitespace-nowrap sm:w-auto" onclick={manualRecheck}>
							{$t('connections.wizard.nextcloud.checkApproval')}
						</button>
					</div>
				{:else}
					<p class="text-sm text-danger">{$t('connections.wizard.nextcloud.timeout')}</p>
					<div class="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
						<button type="button" class="btn-secondary w-full sm:w-auto" onclick={onClose}>{$t('common.cancel')}</button>
						<button type="button" class="btn-primary w-full whitespace-nowrap sm:w-auto" onclick={retryNextcloud}>
							{$t('common.retry')}
						</button>
					</div>
				{/if}
			{:else if kind === 'owntracks'}
				<p class="mb-3 text-sm text-text-secondary">{$t('connections.wizard.owntracks.help')}</p>
				{#if otLoading}
					<p class="text-sm text-text-secondary">{$t('common.loading')}</p>
				{:else if otNotConfigured}
					<p class="text-sm text-danger">{$t('connections.wizard.owntracks.notConfigured')}</p>
				{:else if otLoadError}
					<p class="text-sm text-danger">{otLoadError}</p>
				{:else if otDevices.length === 0}
					<p class="text-sm text-text-secondary">{$t('connections.wizard.owntracks.empty')}</p>
				{:else}
					<form onsubmit={submitOwnTracks}>
						<fieldset class="flex flex-col gap-2">
							<legend class="sr-only">{$t('connections.wizard.owntracks.help')}</legend>
							{#each otDevices as device (deviceKey(device))}
								<label class="flex items-center gap-2 text-sm text-text-primary">
									<input
										type="radio"
										name="owntracks-device"
										value={deviceKey(device)}
										checked={otSelectedKey === deviceKey(device)}
										onchange={() => (otSelectedKey = deviceKey(device))}
									/>
									{$t('connections.wizard.owntracks.deviceOption', { otUser: device.otUser, otDevice: device.otDevice })}
								</label>
							{/each}
						</fieldset>
						{#if errorText}
							<p class="mt-3 text-sm text-danger">{errorText}</p>
						{/if}
						<div class="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
							<button type="button" class="btn-secondary w-full sm:w-auto" onclick={onClose}>{$t('common.cancel')}</button>
							<button type="submit" class="btn-primary w-full whitespace-nowrap sm:w-auto" disabled={submitting || !otSelectedKey}>
								{submitting ? $t('connections.wizard.connecting') : $t('connections.actions.connect')}
							</button>
						</div>
					</form>
				{/if}
			{:else if initialProvider === 'immich'}
				<form onsubmit={submitImmich}>
					<p class="mb-3 text-sm text-text-secondary">{$t('connections.wizard.immich.help')}</p>
					<div class="mb-3">
						<label class="settings-label" for="wizard-immich-server-url">{$t('connections.wizard.immich.serverUrlLabel')}</label>
						<input id="wizard-immich-server-url" type="url" class="settings-input" bind:value={immichServerUrl} />
					</div>
					<div class="mb-3">
						<label class="settings-label" for="wizard-immich-email">{$t('connections.wizard.immich.emailLabel')}</label>
						<input id="wizard-immich-email" type="email" class="settings-input" bind:value={immichEmail} />
					</div>
					<PasswordField
						id="wizard-immich-password"
						label={$t('connections.wizard.immich.passwordLabel')}
						bind:value={immichPassword}
						bind:shown={immichShowPassword}
						autocomplete="current-password"
					/>
					{#if errorText}
						<p class="mt-3 text-sm text-danger">{errorText}</p>
					{/if}
					<div class="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
						<button type="button" class="btn-secondary w-full sm:w-auto" onclick={onClose}>{$t('common.cancel')}</button>
						<button
							type="submit"
							class="btn-primary w-full whitespace-nowrap sm:w-auto"
							disabled={submitting || !immichServerUrl.trim() || !immichEmail.trim() || !immichPassword}
						>
							{submitting ? $t('connections.wizard.connecting') : $t('connections.actions.connect')}
						</button>
					</div>
				</form>
			{:else if initialProvider === 'plex'}
				<form onsubmit={submitPlex}>
					<p class="mb-3 text-sm text-text-secondary">{$t('connections.wizard.plex.help')}</p>
					<div class="mb-3">
						<label class="settings-label" for="wizard-plex-server-url">{$t('connections.wizard.plex.serverUrlLabel')}</label>
						<input id="wizard-plex-server-url" type="url" class="settings-input" bind:value={plexServerUrl} />
					</div>
					<PasswordField
						id="wizard-plex-token"
						label={$t('connections.wizard.plex.tokenLabel')}
						bind:value={plexToken}
						bind:shown={plexShowToken}
						autocomplete="off"
					/>
					{#if errorText}
						<p class="mt-3 text-sm text-danger">{errorText}</p>
					{/if}
					<div class="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
						<button type="button" class="btn-secondary w-full sm:w-auto" onclick={onClose}>{$t('common.cancel')}</button>
						<button
							type="submit"
							class="btn-primary w-full whitespace-nowrap sm:w-auto"
							disabled={submitting || !plexServerUrl.trim() || !plexToken.trim()}
						>
							{submitting ? $t('connections.wizard.connecting') : $t('connections.actions.connect')}
						</button>
					</div>
				</form>
			{:else if initialProvider === 'apple'}
				<form onsubmit={submitApple}>
					<p class="mb-3 text-sm text-text-secondary">{$t('connections.wizard.apple.help')}</p>
					<div class="mb-3">
						<label class="settings-label" for="wizard-apple-id">{$t('connections.wizard.apple.appleIdLabel')}</label>
						<input id="wizard-apple-id" type="email" class="settings-input" bind:value={appleId} />
					</div>
					<PasswordField
						id="wizard-apple-app-password"
						label={$t('connections.wizard.apple.appPasswordLabel')}
						bind:value={appleAppPassword}
						bind:shown={appleShowPassword}
						autocomplete="off"
					/>
					<p class="mt-1 text-xs text-text-muted">
						<a href="https://appleid.apple.com" target="_blank" rel="noopener noreferrer" class="underline">
							{$t('connections.wizard.apple.generateLink')}
						</a>
					</p>
					{#if errorText}
						<p class="mt-3 text-sm text-danger">{errorText}</p>
					{/if}
					<div class="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
						<button type="button" class="btn-secondary w-full sm:w-auto" onclick={onClose}>{$t('common.cancel')}</button>
						<button
							type="submit"
							class="btn-primary w-full whitespace-nowrap sm:w-auto"
							disabled={submitting || !appleId.trim() || !appleAppPassword.trim()}
						>
							{submitting ? $t('connections.wizard.connecting') : $t('connections.actions.connect')}
						</button>
					</div>
				</form>
			{:else if initialProvider === 'imap'}
				<form onsubmit={submitEmail}>
					<p class="mb-3 text-sm text-text-secondary">{$t('connections.wizard.email.help')}</p>
					<div class="mb-3">
						<label class="settings-label" for="wizard-email-address">{$t('connections.wizard.email.emailLabel')}</label>
						<input id="wizard-email-address" type="email" class="settings-input" bind:value={emailAddress} />
					</div>
					<div class="mb-3 grid grid-cols-[1fr_auto] gap-2">
						<div>
							<label class="settings-label" for="wizard-email-imap-host">{$t('connections.wizard.email.imapHostLabel')}</label>
							<input id="wizard-email-imap-host" type="text" class="settings-input" bind:value={imapHost} />
						</div>
						<div>
							<label class="settings-label" for="wizard-email-imap-port">{$t('connections.wizard.email.imapPortLabel')}</label>
							<input
								id="wizard-email-imap-port"
								type="number"
								class="settings-input w-20"
								value={imapPort}
								oninput={(e) => {
									const raw = (e.currentTarget as HTMLInputElement).value;
									imapPort = raw === '' ? '' : Number(raw);
								}}
							/>
						</div>
					</div>
					<label class="mb-3 flex items-center gap-2 text-sm text-text-primary">
						<input type="checkbox" bind:checked={imapSecure} />
						{$t('connections.wizard.email.imapSecureLabel')}
					</label>
					<PasswordField
						id="wizard-email-password"
						label={$t('connections.wizard.email.passwordLabel')}
						bind:value={emailPassword}
						bind:shown={emailShowPassword}
						autocomplete="current-password"
					/>
					<div class="mt-3 grid grid-cols-[1fr_auto] gap-2">
						<div>
							<label class="settings-label" for="wizard-email-smtp-host">{$t('connections.wizard.email.smtpHostLabel')}</label>
							<input id="wizard-email-smtp-host" type="text" class="settings-input" bind:value={smtpHost} />
						</div>
						<div>
							<label class="settings-label" for="wizard-email-smtp-port">{$t('connections.wizard.email.smtpPortLabel')}</label>
							<input
								id="wizard-email-smtp-port"
								type="number"
								class="settings-input w-20"
								value={smtpPort}
								oninput={(e) => {
									const raw = (e.currentTarget as HTMLInputElement).value;
									smtpPort = raw === '' ? '' : Number(raw);
								}}
							/>
						</div>
					</div>
					{#if errorText}
						<p class="mt-3 text-sm text-danger">{errorText}</p>
					{/if}
					<div class="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
						<button type="button" class="btn-secondary w-full sm:w-auto" onclick={onClose}>{$t('common.cancel')}</button>
						<button
							type="submit"
							class="btn-primary w-full whitespace-nowrap sm:w-auto"
							disabled={submitting || !emailAddress.trim() || !imapHost.trim() || !emailPassword}
						>
							{submitting ? $t('connections.wizard.connecting') : $t('connections.actions.connect')}
						</button>
					</div>
				</form>
			{/if}
		</div>
	</DialogShell>
{/if}
