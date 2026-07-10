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
import BrandIcon from "$lib/components/ui/BrandIcon.svelte";
import PasswordField from "./PasswordField.svelte";
import {
	type ConnectionPublic,
	fetchOwnTracksDevices,
	type OwnTracksDevice,
	pollNextcloudConnect,
	startAppleConnect,
	startCalDavConnect,
	startEmailConnect,
	startGitHubConnect,
	startGoogleConnect,
	startImmichConnect,
	startNextcloudConnect,
	startOneDriveConnect,
	startOwnTracksConnect,
	startPlexConnect,
	startTodoistConnect,
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

// The wizard is mounted fresh each open via a parent `{#if}`, so
// `initialProvider` (and the derived `kind`) are truthy on the very first
// render. DialogShell's transitions are LOCAL, so they only play when their
// own containing `{#if}` toggles — a block that is already truthy on mount
// skips the intro (the modal "pops in"). Flipping `visible` false→true after
// mount toggles the block so the fade/scale intro actually plays, matching
// the app's other popup modals.
let visible = $state(false);
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

// --- oauth (Google, OneDrive) -------------------------------------------
// Task 8 — OneDrive is a second oauth-connectMethod provider alongside
// Google, so this branch (and its start-call dispatch below) now serves
// both rather than being Google-only.
let selectedCapabilities = $state<Set<Capability>>(
	new Set(providerEntry?.capabilities ?? []),
);
let oauthNotConfigured = $state(false);

function toggleCapability(capability: Capability) {
	const next = new Set(selectedCapabilities);
	if (next.has(capability)) next.delete(capability);
	else next.add(capability);
	selectedCapabilities = next;
}

async function submitOAuth() {
	if (submitting || selectedCapabilities.size === 0) return;
	submitting = true;
	errorText = "";
	oauthNotConfigured = false;
	try {
		const { authUrl } =
			initialProvider === "onedrive"
				? await startOneDriveConnect([...selectedCapabilities])
				: await startGoogleConnect([...selectedCapabilities]);
		redirectTo(authUrl);
	} catch (err) {
		if (err instanceof ApiError && err.status === 501) {
			oauthNotConfigured = true;
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

// --- app-password (GitHub) -------------------------------------------------
// The PAT itself is never persisted in plaintext, so it can't be prefilled
// on reconnect; the optional Gitea/GHE base URL lives under config.baseUrl
// (see githubConnect in src/lib/server/services/connections/providers/github.ts).
let githubToken = $state("");
let githubShowToken = $state(false);
let githubBaseUrl = $state(reconnectConfigString("baseUrl"));
// One-time snapshot of the initial value (see the `untrack()` doc comment
// above initialProvider) — this only decides whether the Advanced section
// starts expanded; it must not stay reactively tied to githubBaseUrl or
// toggling it closed while a base URL is still typed would immediately
// re-open it.
let githubShowAdvanced = $state(untrack(() => !!githubBaseUrl));

async function submitGitHub(event: Event) {
	event.preventDefault();
	if (submitting) return;
	submitting = true;
	errorText = "";
	try {
		await startGitHubConnect({
			token: githubToken.trim(),
			...(githubBaseUrl.trim() ? { baseUrl: githubBaseUrl.trim() } : {}),
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

// --- app-password (Todoist) --------------------------------------------------
// The API token itself is never persisted in plaintext, so it can't be
// prefilled on reconnect (see todoistConnect in
// src/lib/server/services/connections/providers/todoist.ts).
let todoistToken = $state("");
let todoistShowToken = $state(false);

async function submitTodoist(event: Event) {
	event.preventDefault();
	if (submitting) return;
	submitting = true;
	errorText = "";
	try {
		await startTodoistConnect({ token: todoistToken.trim() });
		onConnected();
		onClose();
	} catch (err) {
		errorText = errMessage(err);
	} finally {
		submitting = false;
	}
}

// --- app-password (CalDAV) ---------------------------------------------------
// The app password itself is never persisted in plaintext, so it can't be
// prefilled on reconnect; serverUrl/username live under config (see
// caldavConnect in
// src/lib/server/services/connections/providers/caldav-tasks.ts).
let caldavServerUrl = $state(reconnectConfigString("serverUrl"));
let caldavUsername = $state(
	reconnectConfigString("username") ||
		(initialReconnectConnection?.accountIdentifier ?? ""),
);
let caldavAppPassword = $state("");
let caldavShowPassword = $state(false);

async function submitCalDav(event: Event) {
	event.preventDefault();
	if (submitting) return;
	submitting = true;
	errorText = "";
	try {
		await startCalDavConnect({
			serverUrl: caldavServerUrl.trim(),
			username: caldavUsername.trim(),
			appPassword: caldavAppPassword.trim(),
		});
		onConnected();
		onClose();
	} catch (err) {
		errorText = errMessage(err);
	} finally {
		submitting = false;
	}
}

// --- app-password (Email / IMAP) — multi-step wizard (ADR 0044 Decision 4)
// -------------------------------------------------------------------------
// Step 1 offers three paths so the user never has to configure a raw IMAP
// client by hand: "alfy" (near-zero-config, host/port derived from the
// email's domain), "gmail" (branded, app-password help + derived Google
// hosts), and "other" (the original manual IMAP form, kept verbatim as the
// fallback for every mailbox that isn't one of the first two). Reconnect
// always jumps straight to "other" — the saved config already has whatever
// host/port/secure values worked last time, so re-deriving from the email's
// domain would be a regression for a mailbox that turned out to need a
// custom host.
type EmailPath = "alfy" | "gmail" | "other";
let emailStep = $state<"choose" | EmailPath>(isReconnect ? "other" : "choose");

function chooseEmailPath(path: EmailPath) {
	emailStep = path;
	errorText = "";
}

function backToEmailChoice() {
	emailStep = "choose";
	errorText = "";
}

// Everything after the LAST "@" — good enough for the mailbox domains this
// derives host names from (and empty for a not-yet-valid address, which
// disables submit rather than POSTing a garbage host).
function domainFromEmail(email: string): string {
	const at = email.lastIndexOf("@");
	return at === -1 ? "" : email.slice(at + 1).trim();
}

// --- Alfy Email path ---
let alfyEmail = $state(
	isReconnect ? (initialReconnectConnection?.accountIdentifier ?? "") : "",
);
let alfyPassword = $state("");
let alfyShowPassword = $state(false);
let alfyDomain = $derived(domainFromEmail(alfyEmail));

async function submitAlfyEmail(event: Event) {
	event.preventDefault();
	if (submitting) return;
	const email = alfyEmail.trim();
	const domain = domainFromEmail(email);
	if (!email || !domain || !alfyPassword) return;
	submitting = true;
	errorText = "";
	try {
		await startEmailConnect({
			email,
			imapHost: `mail.${domain}`,
			imapPort: 993,
			imapSecure: true,
			password: alfyPassword,
			smtpHost: `mail.${domain}`,
			smtpPort: 587,
		});
		onConnected();
		onClose();
	} catch (err) {
		errorText = errMessage(err);
	} finally {
		submitting = false;
	}
}

// --- Gmail path ---
let gmailAddress = $state("");
let gmailAppPassword = $state("");
let gmailShowPassword = $state(false);

async function submitGmailEmail(event: Event) {
	event.preventDefault();
	if (submitting) return;
	const email = gmailAddress.trim();
	if (!email || !gmailAppPassword) return;
	submitting = true;
	errorText = "";
	try {
		await startEmailConnect({
			email,
			imapHost: "imap.gmail.com",
			imapPort: 993,
			imapSecure: true,
			password: gmailAppPassword,
			smtpHost: "smtp.gmail.com",
			smtpPort: 587,
		});
		onConnected();
		onClose();
	} catch (err) {
		errorText = errMessage(err);
	} finally {
		submitting = false;
	}
}

// --- Other (IMAP) path — the original manual form, unchanged ---
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
	visible = true;
	if (kind === "owntracks") void loadOwnTracksDevices();
});
</script>

{#if visible && initialProvider && providerEntry && kind}
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
				<p class="mb-4 text-sm text-text-secondary">{$t('connections.wizard.oauth.intro', { provider: providerEntry.displayName })}</p>
				{#if oauthNotConfigured}
					<p class="mb-4 text-sm text-danger">{$t('connections.wizard.oauth.notConfigured', { provider: providerEntry.displayName })}</p>
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
					{#if !oauthNotConfigured}
						<button
							type="button"
							class="btn-primary w-full whitespace-nowrap sm:w-auto"
							disabled={submitting || selectedCapabilities.size === 0}
							onclick={submitOAuth}
						>
							{submitting ? $t('connections.wizard.oauth.redirecting', { provider: providerEntry.displayName }) : $t('connections.wizard.oauth.continue', { provider: providerEntry.displayName })}
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
							type="text"
							inputmode="url"
							autocomplete="url"
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
						<input
							id="wizard-immich-server-url"
							type="text"
							inputmode="url"
							autocomplete="url"
							class="settings-input"
							bind:value={immichServerUrl}
							placeholder={$t('connections.wizard.immich.serverUrlPlaceholder')}
						/>
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
						<input
							id="wizard-plex-server-url"
							type="text"
							inputmode="url"
							autocomplete="url"
							class="settings-input"
							bind:value={plexServerUrl}
							placeholder={$t('connections.wizard.plex.serverUrlPlaceholder')}
						/>
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
			{:else if initialProvider === 'github'}
				<form onsubmit={submitGitHub}>
					<p class="mb-3 text-sm text-text-secondary">{$t('connections.wizard.github.help')}</p>
					<PasswordField
						id="wizard-github-token"
						label={$t('connections.wizard.github.tokenLabel')}
						bind:value={githubToken}
						bind:shown={githubShowToken}
						autocomplete="off"
						placeholder={$t('connections.wizard.github.tokenPlaceholder')}
					/>
					<p class="mt-1 text-xs text-text-muted">
						<a href="https://github.com/settings/tokens" target="_blank" rel="noopener noreferrer" class="underline">
							{$t('connections.wizard.github.generateLink')}
						</a>
					</p>
					<button
						type="button"
						class="mt-4 text-xs font-medium text-text-secondary underline"
						onclick={() => (githubShowAdvanced = !githubShowAdvanced)}
					>
						{$t('connections.wizard.github.advanced')}
					</button>
					{#if githubShowAdvanced}
						<div class="mt-2">
							<label class="settings-label" for="wizard-github-base-url">{$t('connections.wizard.github.baseUrlLabel')}</label>
							<input
								id="wizard-github-base-url"
								type="text"
								inputmode="url"
								autocomplete="url"
								class="settings-input"
								bind:value={githubBaseUrl}
								placeholder={$t('connections.wizard.github.baseUrlPlaceholder')}
							/>
							<p class="mt-1 text-xs text-text-muted">{$t('connections.wizard.github.baseUrlHelp')}</p>
						</div>
					{/if}
					{#if errorText}
						<p class="mt-3 text-sm text-danger">{errorText}</p>
					{/if}
					<div class="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
						<button type="button" class="btn-secondary w-full sm:w-auto" onclick={onClose}>{$t('common.cancel')}</button>
						<button
							type="submit"
							class="btn-primary w-full whitespace-nowrap sm:w-auto"
							disabled={submitting || !githubToken.trim()}
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
			{:else if initialProvider === 'todoist'}
				<form onsubmit={submitTodoist}>
					<p class="mb-3 text-sm text-text-secondary">{$t('connections.wizard.todoist.help')}</p>
					<PasswordField
						id="wizard-todoist-token"
						label={$t('connections.wizard.todoist.tokenLabel')}
						bind:value={todoistToken}
						bind:shown={todoistShowToken}
						autocomplete="off"
					/>
					<p class="mt-1 text-xs text-text-muted">
						<a href="https://todoist.com/app/settings/integrations/developer" target="_blank" rel="noopener noreferrer" class="underline">
							{$t('connections.wizard.todoist.generateLink')}
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
							disabled={submitting || !todoistToken.trim()}
						>
							{submitting ? $t('connections.wizard.connecting') : $t('connections.actions.connect')}
						</button>
					</div>
				</form>
			{:else if initialProvider === 'caldav'}
				<form onsubmit={submitCalDav}>
					<p class="mb-3 text-sm text-text-secondary">{$t('connections.wizard.caldav.help')}</p>
					<div class="mb-3">
						<label class="settings-label" for="wizard-caldav-server-url">{$t('connections.wizard.caldav.serverUrlLabel')}</label>
						<input
							id="wizard-caldav-server-url"
							type="text"
							inputmode="url"
							autocomplete="url"
							class="settings-input"
							bind:value={caldavServerUrl}
							placeholder={$t('connections.wizard.caldav.serverUrlPlaceholder')}
						/>
					</div>
					<div class="mb-3">
						<label class="settings-label" for="wizard-caldav-username">{$t('connections.wizard.caldav.usernameLabel')}</label>
						<input id="wizard-caldav-username" type="text" autocomplete="username" class="settings-input" bind:value={caldavUsername} />
					</div>
					<PasswordField
						id="wizard-caldav-app-password"
						label={$t('connections.wizard.caldav.appPasswordLabel')}
						bind:value={caldavAppPassword}
						bind:shown={caldavShowPassword}
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
							disabled={submitting || !caldavServerUrl.trim() || !caldavUsername.trim() || !caldavAppPassword.trim()}
						>
							{submitting ? $t('connections.wizard.connecting') : $t('connections.actions.connect')}
						</button>
					</div>
				</form>
			{:else if initialProvider === 'imap'}
				{#if emailStep === 'choose'}
					<p class="mb-3 text-sm text-text-secondary">{$t('connections.wizard.email.choosePath')}</p>
					<div class="flex flex-col gap-2">
						<button type="button" class="email-path-option" onclick={() => chooseEmailPath('alfy')}>
							<BrandIcon provider="email" size={22} ariaHidden />
							<span class="email-path-option-text">
								<span class="email-path-option-name">{$t('connections.wizard.email.path.alfy.name')}</span>
								<span class="email-path-option-description">{$t('connections.wizard.email.path.alfy.description')}</span>
							</span>
						</button>
						<button type="button" class="email-path-option" onclick={() => chooseEmailPath('gmail')}>
							<BrandIcon provider="gmail" size={22} ariaHidden />
							<span class="email-path-option-text">
								<span class="email-path-option-name">{$t('connections.wizard.email.path.gmail.name')}</span>
								<span class="email-path-option-description">{$t('connections.wizard.email.path.gmail.description')}</span>
							</span>
						</button>
						<button type="button" class="email-path-option" onclick={() => chooseEmailPath('other')}>
							<BrandIcon provider="imap" size={22} ariaHidden />
							<span class="email-path-option-text">
								<span class="email-path-option-name">{$t('connections.wizard.email.path.other.name')}</span>
								<span class="email-path-option-description">{$t('connections.wizard.email.path.other.description')}</span>
							</span>
						</button>
					</div>
					<div class="mt-6 flex justify-end">
						<button type="button" class="btn-secondary" onclick={onClose}>{$t('common.cancel')}</button>
					</div>
				{:else if emailStep === 'alfy'}
					<form onsubmit={submitAlfyEmail}>
						<p class="mb-3 text-sm text-text-secondary">{$t('connections.wizard.email.alfy.help')}</p>
						<div class="mb-3">
							<label class="settings-label" for="wizard-alfy-email">{$t('connections.wizard.email.emailLabel')}</label>
							<input id="wizard-alfy-email" type="email" class="settings-input" bind:value={alfyEmail} />
						</div>
						<PasswordField
							id="wizard-alfy-password"
							label={$t('connections.wizard.email.alfy.passwordLabel')}
							bind:value={alfyPassword}
							bind:shown={alfyShowPassword}
							autocomplete="current-password"
						/>
						{#if errorText}
							<p class="mt-3 text-sm text-danger">{errorText}</p>
							<p class="mt-1 text-xs text-text-muted">{$t('connections.wizard.email.alfy.errorHint')}</p>
						{/if}
						<div class="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
							<button type="button" class="btn-secondary w-full sm:w-auto" onclick={backToEmailChoice}>{$t('connections.wizard.back')}</button>
							<button
								type="submit"
								class="btn-primary w-full whitespace-nowrap sm:w-auto"
								disabled={submitting || !alfyEmail.trim() || !alfyDomain || !alfyPassword}
							>
								{submitting ? $t('connections.wizard.connecting') : $t('connections.actions.connect')}
							</button>
						</div>
					</form>
				{:else if emailStep === 'gmail'}
					<form onsubmit={submitGmailEmail}>
						<p class="mb-2 text-sm text-text-secondary">{$t('connections.wizard.email.gmail.help1')}</p>
						<p class="mb-3 text-sm text-text-secondary">{$t('connections.wizard.email.gmail.help2')}</p>
						<div class="mb-3">
							<label class="settings-label" for="wizard-gmail-address">{$t('connections.wizard.email.gmail.emailLabel')}</label>
							<input id="wizard-gmail-address" type="email" class="settings-input" bind:value={gmailAddress} />
						</div>
						<PasswordField
							id="wizard-gmail-app-password"
							label={$t('connections.wizard.email.passwordLabel')}
							bind:value={gmailAppPassword}
							bind:shown={gmailShowPassword}
							autocomplete="off"
						/>
						{#if errorText}
							<p class="mt-3 text-sm text-danger">{errorText}</p>
						{/if}
						<div class="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
							<button type="button" class="btn-secondary w-full sm:w-auto" onclick={backToEmailChoice}>{$t('connections.wizard.back')}</button>
							<button
								type="submit"
								class="btn-primary w-full whitespace-nowrap sm:w-auto"
								disabled={submitting || !gmailAddress.trim() || !gmailAppPassword}
							>
								{submitting ? $t('connections.wizard.connecting') : $t('connections.actions.connect')}
							</button>
						</div>
					</form>
				{:else}
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
						<div class="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
							{#if !isReconnect}
								<button type="button" class="btn-secondary w-full sm:w-auto" onclick={backToEmailChoice}>{$t('connections.wizard.back')}</button>
							{:else}
								<button type="button" class="btn-secondary w-full sm:w-auto" onclick={onClose}>{$t('common.cancel')}</button>
							{/if}
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
			{/if}
		</div>
	</DialogShell>
{/if}

<style>
	/* Issue R4 (ADR 0044 Decision 4) — the Email wizard's step-1 path choice
	   tiles (Alfy Email / Gmail / Other IMAP). Mirrors .settings-card's
	   surface/border language but as a clickable row rather than a static
	   panel. */
	.email-path-option {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		width: 100%;
		padding: 0.75rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-page);
		text-align: left;
		cursor: pointer;
		transition: border-color var(--duration-standard);
	}

	.email-path-option:hover,
	.email-path-option:focus-visible {
		border-color: var(--accent);
	}

	.email-path-option-text {
		display: flex;
		flex-direction: column;
	}

	.email-path-option-name {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--text-primary);
	}

	.email-path-option-description {
		font-size: 0.75rem;
		color: var(--text-muted);
	}
</style>
