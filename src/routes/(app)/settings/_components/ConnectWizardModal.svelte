<script lang="ts">
// Connections redesign — the connect/reconnect wizard.
//
// One chassis, one variant per provider (see wizard-variant.ts, which is
// where the "which screen does this provider get?" mapping now lives). What
// changed inside the chassis:
//
// * Every variant opens with a header saying what the screen is asking for,
//   in words the person can act on: "Access token — a long password you
//   create on GitHub", not "Personal access token"; "Where is your mailbox?"
//   with IMAP kept off the first screen entirely.
// * A missing OAuth app no longer dead-ends at "ask your administrator" — it
//   names the exact Administration page and offers to open it.
// * A blocked pop-up is a real state with a way out, instead of leaving the
//   Nextcloud flow waiting for an approval in a tab that never opened.
// * A submit in flight is a "Connecting …" panel with a Cancel that actually
//   aborts, instead of a greyed button.
// * A failure leads with a sentence and keeps the provider's own words one
//   click away, rather than printing backend phrasing as the whole message.
//
// The parent mounts this conditionally on `provider` being non-null, so every
// open is a fresh instance and everything below takes a one-time snapshot.
import { Check, Clock, ExternalLink, Loader, Ban } from "@lucide/svelte";
import { onDestroy, onMount, untrack } from "svelte";
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
} from "$lib/client/api/connections";
import { ApiError } from "$lib/client/api/http";
import { rememberRequestedCapabilities } from "$lib/client/connections/oauth-request-memo";
import {
	type Capability,
	type ConnectionProvider,
	getProviderCatalogEntry,
} from "$lib/client/connections/provider-catalog";
import { makeGrammarFormatters } from "$lib/client/connections/status-grammar";
import {
	connectWizardVariant,
	initialMailStep,
	type MailPath,
} from "$lib/client/connections/wizard-variant";
import DialogShell from "$lib/components/ui/DialogShell.svelte";
import BrandIcon from "$lib/components/ui/BrandIcon.svelte";
import { t } from "$lib/i18n";
import { uiLanguage } from "$lib/stores/settings";
import PasswordField from "./PasswordField.svelte";
import Disclosure from "./connections/Disclosure.svelte";
import NotSetUpNotice from "./connections/NotSetUpNotice.svelte";
import WizardHeader from "./connections/WizardHeader.svelte";

let {
	provider,
	reconnectConnectionId = null,
	reconnectConnection = null,
	// Connections redesign — capabilities "Ask again" wants the consent screen
	// asked for. Empty means "whatever this provider offers".
	requestedCapabilities = [],
	isAdmin = false,
	onOpenAdminIntegrations,
	onClose,
	onConnected,
	// Indirections around browser navigation APIs so tests can assert on
	// them without a hard `window.location`/`window.open` reference.
	redirectTo = (url: string) => {
		window.location.href = url;
	},
	// Returns the opened window so a blocked pop-up can be detected. A caller
	// (or test double) that returns nothing is treated as "opened" — only an
	// explicit null means the browser refused.
	openWindow = (url: string): Window | null =>
		window.open(url, "_blank", "noopener"),
	pollIntervalMs = 2000,
	pollTimeoutMs = 3 * 60 * 1000,
}: {
	provider: ConnectionProvider | null;
	reconnectConnectionId?: string | null;
	reconnectConnection?: ConnectionPublic | null;
	requestedCapabilities?: string[];
	isAdmin?: boolean;
	onOpenAdminIntegrations?: () => void;
	onClose: () => void;
	onConnected: () => void;
	redirectTo?: (url: string) => void;
	openWindow?: (url: string) => Window | null | undefined;
	pollIntervalMs?: number;
	pollTimeoutMs?: number;
} = $props();

const initialProvider = untrack(() => provider);
const initialReconnectConnectionId = untrack(() => reconnectConnectionId);
const initialReconnectConnection = untrack(() => reconnectConnection);
const initialRequestedCapabilities = untrack(() => requestedCapabilities);

// DialogShell's transitions are local, so a block already truthy on mount
// skips its intro. Flipping this false -> true after mount makes the open
// animation play, matching every other popup in the app.
let visible = $state(false);

const providerEntry = initialProvider
	? getProviderCatalogEntry(initialProvider)
	: null;
const isReconnect = !!initialReconnectConnectionId;
const variant = connectWizardVariant(initialProvider);
const formatters = $derived(makeGrammarFormatters($uiLanguage));

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
// The provider's own words. Shown behind "What went wrong?", never as the
// whole message — `connections.wizard.genericError` is the sentence the user
// reads first. Opened by default for a 4xx, where the server's phrasing is
// usually the actionable part ("invalid credentials").
let errorText = $state("");
let errorDetailOpen = $state(false);

function setError(err: unknown) {
	errorText = errMessage(err);
	errorDetailOpen = err instanceof ApiError && err.status < 500;
}

function clearError() {
	errorText = "";
	errorDetailOpen = false;
}

// One controller per in-flight submit, so the "Connecting …" panel's Cancel
// actually stops waiting rather than hiding a request that keeps running.
let abortController: AbortController | null = null;

function cancelSubmit() {
	abortController?.abort();
	abortController = null;
	submitting = false;
	onClose();
}

async function submitCredentials(run: (signal: AbortSignal) => Promise<void>) {
	if (submitting) return;
	submitting = true;
	clearError();
	const controller = new AbortController();
	abortController = controller;
	try {
		await run(controller.signal);
		onConnected();
		onClose();
	} catch (err) {
		if (controller.signal.aborted) return;
		setError(err);
	} finally {
		if (abortController === controller) abortController = null;
		submitting = false;
	}
}

// --- oauth (Google, OneDrive) -------------------------------------------
let selectedCapabilities = $state<Set<Capability>>(
	new Set(
		initialRequestedCapabilities.length > 0
			? (initialRequestedCapabilities as Capability[]).filter((capability) =>
					providerEntry?.capabilities.includes(capability),
				)
			: (providerEntry?.capabilities ?? []),
	),
);
let oauthNotConfigured = $state(false);

function toggleCapability(capability: Capability) {
	const next = new Set(selectedCapabilities);
	if (next.has(capability)) next.delete(capability);
	else next.add(capability);
	selectedCapabilities = next;
}

async function submitOAuth() {
	if (submitting || selectedCapabilities.size === 0 || !initialProvider) return;
	submitting = true;
	clearError();
	oauthNotConfigured = false;
	const requested = [...selectedCapabilities];
	try {
		const { authUrl } =
			initialProvider === "onedrive"
				? await startOneDriveConnect(requested)
				: await startGoogleConnect(requested);
		// Written down BEFORE the browser leaves, because after the round trip
		// nothing else knows what was asked for — only what was granted.
		rememberRequestedCapabilities(initialProvider, requested);
		redirectTo(authUrl);
	} catch (err) {
		if (err instanceof ApiError && err.status === 501) {
			oauthNotConfigured = true;
		} else {
			setError(err);
		}
	} finally {
		submitting = false;
	}
}

// --- login-flow-v2 (Nextcloud) -----------------------------------------
let ncServerUrl = $state(reconnectConfigString("serverUrl"));
let ncPhase = $state<"form" | "waiting" | "timeout" | "blocked">("form");
let ncPollToken = "";
// Reactive because the waiting/blocked screens show it as the subtitle —
// the user needs to see WHICH server they are being asked to approve on.
let ncPollServerUrl = $state("");
let ncLoginUrl = $state("");
let ncElapsedMs = $state(0);
let ncTimer: ReturnType<typeof setTimeout> | null = null;
// Consecutive failed polls. A single one used to throw the user back to the
// form and lose the login link they were in the middle of approving — a
// dropped packet during a three-minute wait undid the whole flow, and the
// Nextcloud tab they had just signed into was still sitting there. Transient
// failures are now ridden out; only a run of them is treated as broken.
let ncPollFailures = $state(0);
const NC_MAX_POLL_FAILURES = 3;

const ncMinutesLeft = $derived(
	Math.max(1, Math.ceil((pollTimeoutMs - ncElapsedMs) / 60000)),
);

function openNextcloudTab(): boolean {
	const opened = openWindow(ncLoginUrl);
	// Only an explicit null means the browser refused; `undefined` comes from
	// a caller that doesn't report, and must not be read as blocked.
	return opened !== null;
}

async function submitNextcloud(event: Event) {
	event.preventDefault();
	if (submitting) return;
	const serverUrl = ncServerUrl.trim();
	if (!serverUrl) return;
	submitting = true;
	clearError();
	try {
		const result = await startNextcloudConnect(serverUrl);
		ncPollToken = result.pollToken;
		ncPollServerUrl = result.serverUrl;
		ncLoginUrl = result.loginUrl;
		ncElapsedMs = 0;
		ncPollFailures = 0;
		if (!openNextcloudTab()) {
			// The login link is already minted and still valid — the user just
			// needs a way to reach it.
			ncPhase = "blocked";
			return;
		}
		ncPhase = "waiting";
		scheduleNextPoll();
	} catch (err) {
		setError(err);
	} finally {
		submitting = false;
	}
}

// The "Open it now" control is a real <a target="_blank">, not a scripted
// window.open — the browser just refused a scripted one, and a genuine link
// click is the gesture it does allow. So this only resumes the wait; it must
// NOT open the tab itself, or the user gets two Nextcloud tabs and signs in on
// the one whose approval nobody is polling for.
function resumeNextcloudWait() {
	if (ncPhase !== "blocked") return;
	ncPhase = "waiting";
	ncPollFailures = 0;
	scheduleNextPoll();
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
		// A poll that answered at all means the link is alive; forget any
		// earlier blip.
		ncPollFailures = 0;
	} catch (err) {
		ncPollFailures += 1;
		if (ncPollFailures >= NC_MAX_POLL_FAILURES) {
			// Now it looks like the server, not the network. Give up and say
			// so, with the form to try again from.
			setError(err);
			ncPhase = "form";
			return;
		}
		// Otherwise keep waiting: the login link is still minted and the user
		// may already be approving it in the other tab.
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
	ncPollFailures = 0;
	clearError();
}

onDestroy(() => {
	if (ncTimer) clearTimeout(ncTimer);
	abortController?.abort();
});

// --- password-key (Immich) ----------------------------------------------
let immichServerUrl = $state(reconnectConfigString("origin"));
let immichEmail = $state(initialReconnectConnection?.accountIdentifier ?? "");
let immichPassword = $state("");
let immichShowPassword = $state(false);

const submitImmich = (event: Event) => {
	event.preventDefault();
	return submitCredentials((signal) =>
		startImmichConnect(
			{
				serverUrl: immichServerUrl.trim(),
				email: immichEmail.trim(),
				password: immichPassword,
			},
			signal,
		).then(() => undefined),
	);
};

// --- password-key (Plex) -------------------------------------------------
let plexServerUrl = $state(reconnectConfigString("origin"));
let plexToken = $state("");
let plexShowToken = $state(false);

const submitPlex = (event: Event) => {
	event.preventDefault();
	return submitCredentials((signal) =>
		startPlexConnect(
			{ serverUrl: plexServerUrl.trim(), token: plexToken.trim() },
			signal,
		).then(() => undefined),
	);
};

// --- app-password (GitHub) -----------------------------------------------
let githubToken = $state("");
let githubShowToken = $state(false);
let githubBaseUrl = $state(reconnectConfigString("baseUrl"));
let githubShowAdvanced = $state(untrack(() => !!githubBaseUrl));

const submitGitHub = (event: Event) => {
	event.preventDefault();
	return submitCredentials((signal) =>
		startGitHubConnect(
			{
				token: githubToken.trim(),
				...(githubBaseUrl.trim() ? { baseUrl: githubBaseUrl.trim() } : {}),
			},
			signal,
		).then(() => undefined),
	);
};

// --- app-password (Apple) ------------------------------------------------
let appleId = $state(
	reconnectConfigString("appleId") ||
		(initialReconnectConnection?.accountIdentifier ?? ""),
);
let appleAppPassword = $state("");
let appleShowPassword = $state(false);

const submitApple = (event: Event) => {
	event.preventDefault();
	return submitCredentials((signal) =>
		startAppleConnect(
			{ appleId: appleId.trim(), appPassword: appleAppPassword.trim() },
			signal,
		).then(() => undefined),
	);
};

// --- app-password (CalDAV) -----------------------------------------------
let caldavServerUrl = $state(reconnectConfigString("serverUrl"));
let caldavUsername = $state(
	reconnectConfigString("username") ||
		(initialReconnectConnection?.accountIdentifier ?? ""),
);
let caldavAppPassword = $state("");
let caldavShowPassword = $state(false);

const submitCalDav = (event: Event) => {
	event.preventDefault();
	return submitCredentials((signal) =>
		startCalDavConnect(
			{
				serverUrl: caldavServerUrl.trim(),
				username: caldavUsername.trim(),
				appPassword: caldavAppPassword.trim(),
			},
			signal,
		).then(() => undefined),
	);
};

// --- app-password (Email / IMAP) — multi-step ----------------------------
let emailStep = $state<"choose" | MailPath>(initialMailStep(isReconnect));

function chooseEmailPath(path: MailPath) {
	emailStep = path;
	clearError();
}

function backToEmailChoice() {
	emailStep = "choose";
	clearError();
}

function domainFromEmail(email: string): string {
	const at = email.lastIndexOf("@");
	return at === -1 ? "" : email.slice(at + 1).trim();
}

let alfyEmail = $state(
	isReconnect ? (initialReconnectConnection?.accountIdentifier ?? "") : "",
);
let alfyPassword = $state("");
let alfyShowPassword = $state(false);
let alfyDomain = $derived(domainFromEmail(alfyEmail));

const submitAlfyEmail = (event: Event) => {
	event.preventDefault();
	const email = alfyEmail.trim();
	const domain = domainFromEmail(email);
	if (!email || !domain || !alfyPassword) return;
	return submitCredentials((signal) =>
		startEmailConnect(
			{
				email,
				imapHost: `mail.${domain}`,
				imapPort: 993,
				imapSecure: true,
				password: alfyPassword,
				smtpHost: `mail.${domain}`,
				smtpPort: 587,
			},
			signal,
		).then(() => undefined),
	);
};

let gmailAddress = $state("");
let gmailAppPassword = $state("");
let gmailShowPassword = $state(false);

const submitGmailEmail = (event: Event) => {
	event.preventDefault();
	const email = gmailAddress.trim();
	if (!email || !gmailAppPassword) return;
	return submitCredentials((signal) =>
		startEmailConnect(
			{
				email,
				imapHost: "imap.gmail.com",
				imapPort: 993,
				imapSecure: true,
				password: gmailAppPassword,
				smtpHost: "smtp.gmail.com",
				smtpPort: 587,
			},
			signal,
		).then(() => undefined),
	);
};

let emailAddress = $state(initialReconnectConnection?.accountIdentifier ?? "");
let imapHost = $state(reconnectConfigString("imapHost"));
let imapPort = $state<number | "">(reconnectConfigNumber("imapPort") ?? 993);
let imapSecure = $state<boolean>(reconnectConfigBoolean("imapSecure", true));
let emailPassword = $state("");
let emailShowPassword = $state(false);
let smtpHost = $state(reconnectConfigString("smtpHost"));
let smtpPort = $state<number | "">(reconnectConfigNumber("smtpPort") ?? "");

const submitEmail = (event: Event) => {
	event.preventDefault();
	return submitCredentials((signal) =>
		startEmailConnect(
			{
				email: emailAddress.trim(),
				imapHost: imapHost.trim(),
				...(imapPort !== "" ? { imapPort } : {}),
				imapSecure,
				password: emailPassword,
				...(smtpHost.trim() ? { smtpHost: smtpHost.trim() } : {}),
				...(smtpPort !== "" ? { smtpPort } : {}),
			},
			signal,
		).then(() => undefined),
	);
};

// --- OwnTracks device picker ---------------------------------------------
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
		// One device and nothing to choose between: pre-select it so the
		// primary action isn't disabled for a decision with one answer.
		if (otDevices.length === 1) otSelectedKey = deviceKey(otDevices[0]);
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

// Not routed through submitCredentials: the 409 branch is a state change, not
// a success, so it must not fall through to onConnected()/onClose().
async function submitOwnTracks(event: Event) {
	event.preventDefault();
	if (submitting || !otSelectedKey) return;
	const selected = otDevices.find((d) => deviceKey(d) === otSelectedKey);
	if (!selected) return;
	submitting = true;
	clearError();
	const controller = new AbortController();
	abortController = controller;
	try {
		await startOwnTracksConnect(
			{ otUser: selected.otUser, otDevice: selected.otDevice },
			controller.signal,
		);
		onConnected();
		onClose();
	} catch (err) {
		if (controller.signal.aborted) return;
		// The start route maps "no recorder configured" to 409, same as the
		// listing — flip to the admin-setup state rather than printing a raw
		// error the user can do nothing with.
		if (err instanceof ApiError && err.status === 409) {
			otNotConfigured = true;
		} else {
			setError(err);
		}
	} finally {
		if (abortController === controller) abortController = null;
		submitting = false;
	}
}

onMount(() => {
	visible = true;
	if (variant === "owntracks") void loadOwnTracksDevices();
});

const providerName = $derived(providerEntry?.displayName ?? "");
</script>

{#snippet errorBlock()}
	{#if errorText}
		<div class="wizard-error" data-testid="wizard-error">
			<p class="wizard-error-line">{$t('connections.wizard.genericError')}</p>
			<Disclosure
				label={$t('connections.actions.whatWentWrong')}
				bind:open={errorDetailOpen}
				testId="wizard-error-detail"
			>
				<p class="wizard-error-detail">{errorText}</p>
			</Disclosure>
		</div>
	{/if}
{/snippet}

{#snippet connectingPanel()}
	<div class="connecting" data-testid="wizard-connecting">
		<span class="connecting-spinner" aria-hidden="true">
			<Loader size={22} strokeWidth={2} />
		</span>
		<p class="connecting-title">
			{$t('connections.states.connecting.title', { provider: providerName })}
		</p>
		<p class="connecting-hint">{$t('connections.states.connecting.hint')}</p>
	</div>
	<div class="wizard-foot">
		<span class="wizard-foot-spacer"></span>
		<button type="button" class="btn-secondary w-full sm:w-auto" onclick={cancelSubmit}>
			{$t('common.cancel')}
		</button>
	</div>
{/snippet}

{#if visible && initialProvider && providerEntry && variant}
	<DialogShell
		title={isReconnect
			? $t('connections.wizard.titleReconnect', { provider: providerName })
			: $t('connections.wizard.titleConnect', { provider: providerName })}
		onClose={onClose}
		maxWidthClass="max-w-[32rem]"
		zIndexClass="z-[9999]"
		titleVisuallyHidden
	>
		<div class="wizard">
			{#if variant === 'unavailable'}
				<WizardHeader
					provider={initialProvider}
					title={$t('connections.wizard.titleConnect', { provider: providerName })}
					subtitle={$t('connections.wizard.contacts.subtitle')}
				/>
				<p class="wizard-help">{$t('connections.wizard.contacts.notAvailable')}</p>
				<div class="wizard-foot">
					<span class="wizard-foot-spacer"></span>
					<button type="button" class="btn-secondary" onclick={onClose}>
						{$t('common.close')}
					</button>
				</div>

			{:else if variant === 'oauth'}
				<WizardHeader
					provider={initialProvider}
					title={$t('connections.wizard.titleConnect', { provider: providerName })}
					subtitle={oauthNotConfigured
						? $t('connections.wizard.notSetUp.subtitle')
						: $t('connections.wizard.oauth.subtitle', { provider: providerName })}
				/>
				{#if oauthNotConfigured}
					<NotSetUpNotice
						{isAdmin}
						body={isAdmin
							? $t('connections.wizard.notSetUp.bodyAdmin', { provider: providerName })
							: $t('connections.wizard.notSetUp.bodyMember', { provider: providerName })}
						onOpen={onOpenAdminIntegrations}
					/>
					<div class="wizard-foot">
						<span class="wizard-foot-spacer"></span>
						<button type="button" class="btn-secondary" onclick={onClose}>
							{$t('common.close')}
						</button>
					</div>
				{:else}
					<fieldset class="capability-choices">
						<legend class="sr-only">{$t('connections.capabilities.label')}</legend>
						{#each providerEntry.capabilities as capability (capability)}
							{@const checked = selectedCapabilities.has(capability)}
							{@const capabilityName = $t(
								`connections.capability.${capability}` as Parameters<typeof $t>[0],
							)}
							<label class="capability-choice">
								<!-- The visible box is a styled span, so the real control keeps
								     its own short accessible name rather than inheriting the
								     label's name + description. -->
								<input
									type="checkbox"
									class="sr-only"
									aria-label={capabilityName}
									{checked}
									onchange={() => toggleCapability(capability)}
								/>
								<span class="capability-box" class:checked aria-hidden="true">
									{#if checked}
										<Check size={12} strokeWidth={3} />
									{/if}
								</span>
								<span class="capability-copy">
									<span class="capability-name">{capabilityName}</span>
									<span class="capability-about">
										{$t(`connections.capabilityAbout.${capability}` as Parameters<typeof $t>[0])}
									</span>
								</span>
							</label>
						{/each}
					</fieldset>
					{#if selectedCapabilities.size === 0}
						<p class="wizard-inline-error">{$t('connections.wizard.selectAtLeastOne')}</p>
					{/if}
					{@render errorBlock()}
					<div class="wizard-foot">
						<span class="wizard-foot-spacer"></span>
						<button type="button" class="btn-secondary w-full sm:w-auto" onclick={onClose}>
							{$t('common.cancel')}
						</button>
						<button
							type="button"
							class="btn-primary w-full whitespace-nowrap sm:w-auto"
							disabled={submitting || selectedCapabilities.size === 0}
							onclick={submitOAuth}
						>
							{submitting
								? $t('connections.wizard.oauth.redirecting', { provider: providerName })
								: $t('connections.wizard.oauth.continue', { provider: providerName })}
						</button>
					</div>
				{/if}

			{:else if variant === 'nextcloud'}
				{#if ncPhase === 'form'}
					<form onsubmit={submitNextcloud}>
						<WizardHeader
							provider="nextcloud"
							title={$t('connections.wizard.titleConnect', { provider: providerName })}
							subtitle={$t('connections.wizard.nextcloud.subtitle')}
						/>
						<label class="settings-label" for="wizard-nextcloud-server-url">
							{$t('connections.wizard.nextcloud.serverUrlLabel')}
						</label>
						<input
							id="wizard-nextcloud-server-url"
							type="text"
							inputmode="url"
							autocomplete="url"
							class="settings-input"
							bind:value={ncServerUrl}
							placeholder={$t('connections.wizard.nextcloud.serverUrlPlaceholder')}
						/>
						{@render errorBlock()}
						<div class="wizard-foot">
							<span class="wizard-foot-spacer"></span>
							<button type="button" class="btn-secondary w-full sm:w-auto" onclick={onClose}>
								{$t('common.cancel')}
							</button>
							<button
								type="submit"
								class="btn-primary w-full whitespace-nowrap sm:w-auto"
								disabled={submitting || !ncServerUrl.trim()}
							>
								{submitting
									? $t('connections.wizard.connecting')
									: $t('connections.actions.connect')}
							</button>
						</div>
					</form>
				{:else if ncPhase === 'blocked'}
					<!-- The login link is minted and still valid; the tab just never
					     opened. Previously this left the flow silently stuck. -->
					<WizardHeader
						provider="nextcloud"
						title={$t('connections.states.popupBlocked.title', { provider: providerName })}
						subtitle={ncPollServerUrl}
					/>
					<div class="blocked" data-testid="wizard-popup-blocked">
						<span class="blocked-icon" aria-hidden="true">
							<Ban size={15} strokeWidth={2} />
						</span>
						<p class="blocked-body">{$t('connections.states.popupBlocked.body')}</p>
					</div>
					<div class="wizard-foot">
						<span class="wizard-foot-spacer"></span>
						<button type="button" class="btn-secondary w-full sm:w-auto" onclick={onClose}>
							{$t('common.cancel')}
						</button>
						<a
							class="btn-primary inline-flex w-full items-center justify-center gap-1.5 whitespace-nowrap no-underline sm:w-auto"
							href={ncLoginUrl}
							target="_blank"
							rel="noopener noreferrer"
							data-testid="wizard-popup-blocked-open"
							onclick={resumeNextcloudWait}
						>
							<ExternalLink size={14} strokeWidth={2} aria-hidden="true" />
							{$t('connections.actions.openItNow')}
						</a>
					</div>
				{:else if ncPhase === 'waiting'}
					<WizardHeader
						provider="nextcloud"
						title={$t('connections.wizard.titleConnect', { provider: providerName })}
						subtitle={ncPollServerUrl}
					/>
					<div class="waiting" data-testid="wizard-nextcloud-waiting">
						<span class="waiting-spinner" aria-hidden="true">
							<Loader size={24} strokeWidth={2} />
						</span>
						<p class="waiting-title">{$t('connections.wizard.nextcloud.waitingTitle')}</p>
						<p class="waiting-body">
							{$t('connections.wizard.nextcloud.waitingBody', { provider: providerName })}
						</p>
						<p class="waiting-expiry">
							<Clock size={11} strokeWidth={2} aria-hidden="true" />
							{$t('connections.wizard.nextcloud.expires', { minutes: ncMinutesLeft })}
						</p>
					</div>
					{@render errorBlock()}
					<div class="wizard-foot">
						<span class="wizard-foot-spacer"></span>
						<button
							type="button"
							class="btn-secondary w-full sm:w-auto"
							onclick={cancelNextcloudWait}
						>
							{$t('common.cancel')}
						</button>
						<button
							type="button"
							class="btn-primary w-full whitespace-nowrap sm:w-auto"
							onclick={manualRecheck}
						>
							{$t('connections.wizard.nextcloud.approved')}
						</button>
					</div>
				{:else}
					<WizardHeader
						provider="nextcloud"
						title={$t('connections.wizard.titleConnect', { provider: providerName })}
						subtitle={ncPollServerUrl}
					/>
					<p class="wizard-inline-error">{$t('connections.wizard.nextcloud.timeout')}</p>
					<div class="wizard-foot">
						<span class="wizard-foot-spacer"></span>
						<button type="button" class="btn-secondary w-full sm:w-auto" onclick={onClose}>
							{$t('common.cancel')}
						</button>
						<button
							type="button"
							class="btn-primary w-full whitespace-nowrap sm:w-auto"
							onclick={retryNextcloud}
						>
							{$t('common.retry')}
						</button>
					</div>
				{/if}

			{:else if variant === 'owntracks'}
				<WizardHeader
					provider="owntracks"
					title={$t('connections.wizard.titleConnect', { provider: providerName })}
					subtitle={otNotConfigured
						? $t('connections.wizard.notSetUp.subtitle')
						: $t('connections.wizard.owntracks.subtitle')}
				/>
				{#if submitting}
					{@render connectingPanel()}
				{:else if otLoading}
					<p class="wizard-help">{$t('common.loading')}</p>
				{:else if otNotConfigured}
					<!-- Was a dead end: "ask your administrator to set the OwnTracks
					     Recorder URL", with no way to get there. -->
					<NotSetUpNotice
						{isAdmin}
						body={isAdmin
							? $t('connections.wizard.notSetUp.ownTracksAdmin')
							: $t('connections.wizard.notSetUp.ownTracksMember')}
						onOpen={onOpenAdminIntegrations}
					/>
					<div class="wizard-foot">
						<span class="wizard-foot-spacer"></span>
						<button type="button" class="btn-secondary" onclick={onClose}>
							{$t('common.close')}
						</button>
					</div>
				{:else if otLoadError}
					<div class="wizard-error">
						<p class="wizard-error-line">{$t('connections.wizard.genericError')}</p>
						<Disclosure label={$t('connections.actions.whatWentWrong')}>
							<p class="wizard-error-detail">{otLoadError}</p>
						</Disclosure>
					</div>
					<div class="wizard-foot">
						<span class="wizard-foot-spacer"></span>
						<button type="button" class="btn-secondary w-full sm:w-auto" onclick={onClose}>
							{$t('common.cancel')}
						</button>
						<button
							type="button"
							class="btn-primary w-full sm:w-auto"
							onclick={loadOwnTracksDevices}
						>
							{$t('connections.actions.tryAgain')}
						</button>
					</div>
				{:else if otDevices.length === 0}
					<p class="wizard-help">{$t('connections.wizard.owntracks.empty')}</p>
					<div class="wizard-foot">
						<span class="wizard-foot-spacer"></span>
						<button type="button" class="btn-secondary w-full sm:w-auto" onclick={onClose}>
							{$t('common.cancel')}
						</button>
						<button
							type="button"
							class="btn-primary w-full sm:w-auto"
							onclick={loadOwnTracksDevices}
						>
							{$t('connections.actions.tryAgain')}
						</button>
					</div>
				{:else}
					<form onsubmit={submitOwnTracks}>
						<fieldset class="device-list">
							<legend class="sr-only">{$t('connections.wizard.owntracks.subtitle')}</legend>
							{#each otDevices as device (deviceKey(device))}
								{@const key = deviceKey(device)}
								<label class="device-option" class:selected={otSelectedKey === key}>
									<input
										type="radio"
										name="owntracks-device"
										class="sr-only"
										aria-label={device.otDevice}
										value={key}
										checked={otSelectedKey === key}
										onchange={() => (otSelectedKey = key)}
									/>
									<span class="device-radio" class:checked={otSelectedKey === key} aria-hidden="true"></span>
									<span class="device-copy">
										<span class="device-name">{device.otDevice}</span>
										<span class="device-sub">
											{#if device.lastSeen}
												{$t('connections.wizard.owntracks.lastSeen', {
													when: formatters.relative(device.lastSeen),
												})}
											{:else}
												{$t('connections.wizard.owntracks.onRecorderAs', {
													otUser: device.otUser,
												})}
											{/if}
										</span>
									</span>
								</label>
							{/each}
						</fieldset>
						{@render errorBlock()}
						<div class="wizard-foot">
							<span class="wizard-foot-spacer"></span>
							<button type="button" class="btn-secondary w-full sm:w-auto" onclick={onClose}>
								{$t('common.cancel')}
							</button>
							<button
								type="submit"
								class="btn-primary w-full whitespace-nowrap sm:w-auto"
								disabled={!otSelectedKey}
							>
								{$t('connections.wizard.owntracks.useThisDevice')}
							</button>
						</div>
					</form>
				{/if}

			{:else if variant === 'immich'}
				<WizardHeader
					provider="immich"
					title={$t('connections.wizard.titleConnect', { provider: providerName })}
					subtitle={$t('connections.wizard.immich.subtitle')}
				/>
				{#if submitting}
					{@render connectingPanel()}
				{:else}
					<form onsubmit={submitImmich}>
						<div class="mb-3">
							<label class="settings-label" for="wizard-immich-server-url">
								{$t('connections.wizard.immich.serverUrlLabel')}
							</label>
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
							<label class="settings-label" for="wizard-immich-email">
								{$t('connections.wizard.immich.emailLabel')}
							</label>
							<input id="wizard-immich-email" type="email" class="settings-input" bind:value={immichEmail} />
						</div>
						<PasswordField
							id="wizard-immich-password"
							label={$t('connections.wizard.immich.passwordLabel')}
							bind:value={immichPassword}
							bind:shown={immichShowPassword}
							autocomplete="current-password"
						/>
						<p class="wizard-field-help">{$t('connections.wizard.immich.help')}</p>
						{@render errorBlock()}
						<div class="wizard-foot">
							<span class="wizard-foot-spacer"></span>
							<button type="button" class="btn-secondary w-full sm:w-auto" onclick={onClose}>
								{$t('common.cancel')}
							</button>
							<button
								type="submit"
								class="btn-primary w-full whitespace-nowrap sm:w-auto"
								disabled={!immichServerUrl.trim() || !immichEmail.trim() || !immichPassword}
							>
								{$t('connections.actions.connect')}
							</button>
						</div>
					</form>
				{/if}

			{:else if variant === 'plex'}
				<WizardHeader
					provider="plex"
					title={$t('connections.wizard.titleConnect', { provider: providerName })}
					subtitle={$t('connections.wizard.plex.subtitle')}
				/>
				{#if submitting}
					{@render connectingPanel()}
				{:else}
					<form onsubmit={submitPlex}>
						<div class="mb-3">
							<label class="settings-label" for="wizard-plex-server-url">
								{$t('connections.wizard.plex.serverUrlLabel')}
							</label>
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
						<p class="wizard-field-help">{$t('connections.wizard.plex.help')}</p>
						{@render errorBlock()}
						<div class="wizard-foot">
							<span class="wizard-foot-spacer"></span>
							<button type="button" class="btn-secondary w-full sm:w-auto" onclick={onClose}>
								{$t('common.cancel')}
							</button>
							<button
								type="submit"
								class="btn-primary w-full whitespace-nowrap sm:w-auto"
								disabled={!plexServerUrl.trim() || !plexToken.trim()}
							>
								{$t('connections.actions.connect')}
							</button>
						</div>
					</form>
				{/if}

			{:else if variant === 'github'}
				<WizardHeader
					provider="github"
					title={$t('connections.wizard.titleConnect', { provider: providerName })}
					subtitle={$t('connections.wizard.github.subtitle')}
				/>
				{#if submitting}
					{@render connectingPanel()}
				{:else}
					<form onsubmit={submitGitHub}>
						<PasswordField
							id="wizard-github-token"
							label={$t('connections.wizard.github.tokenLabel2')}
							bind:value={githubToken}
							bind:shown={githubShowToken}
							autocomplete="off"
							placeholder={$t('connections.wizard.github.tokenPlaceholder')}
						/>
						<p class="wizard-field-help">{$t('connections.wizard.github.tokenHelp')}</p>
						<p class="wizard-link-row">
							<a
								class="wizard-link"
								href="https://github.com/settings/tokens"
								target="_blank"
								rel="noopener noreferrer"
							>
								<ExternalLink size={12} strokeWidth={2} aria-hidden="true" />
								{$t('connections.wizard.github.createOn')}
							</a>
						</p>
						<div class="wizard-advanced">
							<Disclosure
								label={$t('connections.wizard.github.differentServer')}
								bind:open={githubShowAdvanced}
								testId="wizard-github-advanced"
							>
								<label class="settings-label" for="wizard-github-base-url">
									{$t('connections.wizard.github.baseUrlLabel')}
								</label>
								<input
									id="wizard-github-base-url"
									type="text"
									inputmode="url"
									autocomplete="url"
									class="settings-input"
									bind:value={githubBaseUrl}
									placeholder={$t('connections.wizard.github.baseUrlPlaceholder')}
								/>
								<p class="wizard-field-help">{$t('connections.wizard.github.baseUrlHelp')}</p>
							</Disclosure>
						</div>
						{@render errorBlock()}
						<div class="wizard-foot">
							<span class="wizard-foot-spacer"></span>
							<button type="button" class="btn-secondary w-full sm:w-auto" onclick={onClose}>
								{$t('common.cancel')}
							</button>
							<button
								type="submit"
								class="btn-primary w-full whitespace-nowrap sm:w-auto"
								disabled={!githubToken.trim()}
							>
								{$t('connections.actions.connect')}
							</button>
						</div>
					</form>
				{/if}

			{:else if variant === 'apple'}
				<WizardHeader
					provider="apple"
					title={$t('connections.wizard.titleConnect', { provider: providerName })}
					subtitle={$t('connections.wizard.apple.subtitle')}
				/>
				{#if submitting}
					{@render connectingPanel()}
				{:else}
					<form onsubmit={submitApple}>
						<div class="mb-3">
							<label class="settings-label" for="wizard-apple-id">
								{$t('connections.wizard.apple.appleIdLabel')}
							</label>
							<input id="wizard-apple-id" type="email" class="settings-input" bind:value={appleId} />
						</div>
						<PasswordField
							id="wizard-apple-app-password"
							label={$t('connections.wizard.apple.appPasswordLabel')}
							bind:value={appleAppPassword}
							bind:shown={appleShowPassword}
							autocomplete="off"
						/>
						<p class="wizard-field-help">{$t('connections.wizard.apple.help')}</p>
						<p class="wizard-link-row">
							<a
								class="wizard-link"
								href="https://appleid.apple.com"
								target="_blank"
								rel="noopener noreferrer"
							>
								<ExternalLink size={12} strokeWidth={2} aria-hidden="true" />
								{$t('connections.wizard.apple.generateLink')}
							</a>
						</p>
						{@render errorBlock()}
						<div class="wizard-foot">
							<span class="wizard-foot-spacer"></span>
							<button type="button" class="btn-secondary w-full sm:w-auto" onclick={onClose}>
								{$t('common.cancel')}
							</button>
							<button
								type="submit"
								class="btn-primary w-full whitespace-nowrap sm:w-auto"
								disabled={!appleId.trim() || !appleAppPassword.trim()}
							>
								{$t('connections.actions.connect')}
							</button>
						</div>
					</form>
				{/if}

			{:else if variant === 'caldav'}
				<WizardHeader
					provider="caldav"
					title={$t('connections.wizard.titleConnect', { provider: providerName })}
					subtitle={$t('connections.wizard.caldav.subtitle')}
				/>
				{#if submitting}
					{@render connectingPanel()}
				{:else}
					<form onsubmit={submitCalDav}>
						<div class="mb-3">
							<label class="settings-label" for="wizard-caldav-server-url">
								{$t('connections.wizard.caldav.serverUrlLabel')}
							</label>
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
							<label class="settings-label" for="wizard-caldav-username">
								{$t('connections.wizard.caldav.usernameLabel')}
							</label>
							<input
								id="wizard-caldav-username"
								type="text"
								autocomplete="username"
								class="settings-input"
								bind:value={caldavUsername}
							/>
						</div>
						<PasswordField
							id="wizard-caldav-app-password"
							label={$t('connections.wizard.caldav.appPasswordLabel')}
							bind:value={caldavAppPassword}
							bind:shown={caldavShowPassword}
							autocomplete="off"
						/>
						<p class="wizard-field-help">{$t('connections.wizard.caldav.help')}</p>
						{@render errorBlock()}
						<div class="wizard-foot">
							<span class="wizard-foot-spacer"></span>
							<button type="button" class="btn-secondary w-full sm:w-auto" onclick={onClose}>
								{$t('common.cancel')}
							</button>
							<button
								type="submit"
								class="btn-primary w-full whitespace-nowrap sm:w-auto"
								disabled={!caldavServerUrl.trim() ||
									!caldavUsername.trim() ||
									!caldavAppPassword.trim()}
							>
								{$t('connections.actions.connect')}
							</button>
						</div>
					</form>
				{/if}

			{:else if variant === 'mail'}
				{#if submitting}
					<WizardHeader
						provider="imap"
						title={$t('connections.wizard.email.title')}
						subtitle=""
					/>
					{@render connectingPanel()}
				{:else if emailStep === 'choose'}
					<!-- "IMAP" is deliberately absent from this screen: it only
					     appears once someone chooses "Somewhere else". -->
					<WizardHeader
						provider="imap"
						title={$t('connections.wizard.email.title')}
						subtitle={$t('connections.wizard.email.subtitle')}
					/>
					<div class="path-list">
						<button type="button" class="path-option" onclick={() => chooseEmailPath('alfy')}>
							<span class="path-mark"><BrandIcon provider="email" size={14} ariaHidden /></span>
							<span class="path-copy">
								<span class="path-name">{$t('connections.wizard.email.path.alfy.name')}</span>
								<span class="path-sub">{$t('connections.wizard.email.path.alfy.description2')}</span>
							</span>
						</button>
						<button type="button" class="path-option" onclick={() => chooseEmailPath('gmail')}>
							<span class="path-mark"><BrandIcon provider="gmail" size={14} ariaHidden /></span>
							<span class="path-copy">
								<span class="path-name">{$t('connections.wizard.email.path.gmail.name')}</span>
								<span class="path-sub">{$t('connections.wizard.email.path.gmail.description2')}</span>
							</span>
						</button>
						<button type="button" class="path-option" onclick={() => chooseEmailPath('other')}>
							<span class="path-mark"><BrandIcon provider="imap" size={14} ariaHidden /></span>
							<span class="path-copy">
								<span class="path-name">{$t('connections.wizard.email.path.other.name2')}</span>
								<span class="path-sub">{$t('connections.wizard.email.path.other.description2')}</span>
							</span>
						</button>
					</div>
					<div class="wizard-foot">
						<span class="wizard-foot-spacer"></span>
						<button type="button" class="btn-secondary" onclick={onClose}>
							{$t('common.cancel')}
						</button>
					</div>
				{:else if emailStep === 'alfy'}
					<form onsubmit={submitAlfyEmail}>
						<WizardHeader
							provider="email"
							title={$t('connections.wizard.email.path.alfy.name')}
							subtitle={$t('connections.wizard.email.path.alfy.description2')}
						/>
						<div class="mb-3">
							<label class="settings-label" for="wizard-alfy-email">
								{$t('connections.wizard.email.emailLabel')}
							</label>
							<input id="wizard-alfy-email" type="email" class="settings-input" bind:value={alfyEmail} />
						</div>
						<PasswordField
							id="wizard-alfy-password"
							label={$t('connections.wizard.email.alfy.passwordLabel')}
							bind:value={alfyPassword}
							bind:shown={alfyShowPassword}
							autocomplete="current-password"
						/>
						<p class="wizard-field-help">{$t('connections.wizard.email.alfy.help')}</p>
						{#if errorText}
							{@render errorBlock()}
							<p class="wizard-field-help">{$t('connections.wizard.email.alfy.errorHint')}</p>
						{/if}
						<div class="wizard-foot">
							<button type="button" class="btn-secondary w-full sm:w-auto" onclick={backToEmailChoice}>
								{$t('connections.wizard.back')}
							</button>
							<span class="wizard-foot-spacer"></span>
							<button
								type="submit"
								class="btn-primary w-full whitespace-nowrap sm:w-auto"
								disabled={!alfyEmail.trim() || !alfyDomain || !alfyPassword}
							>
								{$t('connections.actions.connect')}
							</button>
						</div>
					</form>
				{:else if emailStep === 'gmail'}
					<form onsubmit={submitGmailEmail}>
						<WizardHeader
							provider="gmail"
							title={$t('connections.wizard.email.path.gmail.name')}
							subtitle={$t('connections.wizard.email.path.gmail.description2')}
						/>
						<div class="mb-3">
							<label class="settings-label" for="wizard-gmail-address">
								{$t('connections.wizard.email.gmail.emailLabel')}
							</label>
							<input id="wizard-gmail-address" type="email" class="settings-input" bind:value={gmailAddress} />
						</div>
						<PasswordField
							id="wizard-gmail-app-password"
							label={$t('connections.wizard.email.passwordLabel')}
							bind:value={gmailAppPassword}
							bind:shown={gmailShowPassword}
							autocomplete="off"
						/>
						<p class="wizard-field-help">{$t('connections.wizard.email.gmail.help1')}</p>
						<p class="wizard-field-help">{$t('connections.wizard.email.gmail.help2')}</p>
						{@render errorBlock()}
						<div class="wizard-foot">
							<button type="button" class="btn-secondary w-full sm:w-auto" onclick={backToEmailChoice}>
								{$t('connections.wizard.back')}
							</button>
							<span class="wizard-foot-spacer"></span>
							<button
								type="submit"
								class="btn-primary w-full whitespace-nowrap sm:w-auto"
								disabled={!gmailAddress.trim() || !gmailAppPassword}
							>
								{$t('connections.actions.connect')}
							</button>
						</div>
					</form>
				{:else}
					<form onsubmit={submitEmail}>
						<WizardHeader
							provider="imap"
							title={$t('connections.wizard.email.path.other.name2')}
							subtitle={$t('connections.wizard.email.path.other.description2')}
						/>
						<div class="mb-3">
							<label class="settings-label" for="wizard-email-address">
								{$t('connections.wizard.email.emailLabel')}
							</label>
							<input id="wizard-email-address" type="email" class="settings-input" bind:value={emailAddress} />
						</div>
						<div class="mb-3 grid grid-cols-[1fr_auto] gap-2">
							<div>
								<label class="settings-label" for="wizard-email-imap-host">
									{$t('connections.wizard.email.imapHostLabel')}
								</label>
								<input id="wizard-email-imap-host" type="text" class="settings-input" bind:value={imapHost} />
							</div>
							<div>
								<label class="settings-label" for="wizard-email-imap-port">
									{$t('connections.wizard.email.imapPortLabel')}
								</label>
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
								<label class="settings-label" for="wizard-email-smtp-host">
									{$t('connections.wizard.email.smtpHostLabel')}
								</label>
								<input id="wizard-email-smtp-host" type="text" class="settings-input" bind:value={smtpHost} />
							</div>
							<div>
								<label class="settings-label" for="wizard-email-smtp-port">
									{$t('connections.wizard.email.smtpPortLabel')}
								</label>
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
						<p class="wizard-field-help">{$t('connections.wizard.email.help')}</p>
						{@render errorBlock()}
						<div class="wizard-foot">
							{#if !isReconnect}
								<button type="button" class="btn-secondary w-full sm:w-auto" onclick={backToEmailChoice}>
									{$t('connections.wizard.back')}
								</button>
							{:else}
								<button type="button" class="btn-secondary w-full sm:w-auto" onclick={onClose}>
									{$t('common.cancel')}
								</button>
							{/if}
							<span class="wizard-foot-spacer"></span>
							<button
								type="submit"
								class="btn-primary w-full whitespace-nowrap sm:w-auto"
								disabled={!emailAddress.trim() || !imapHost.trim() || !emailPassword}
							>
								{$t('connections.actions.connect')}
							</button>
						</div>
					</form>
				{/if}
			{/if}
		</div>
	</DialogShell>
{/if}

<style>
	.wizard {
		max-height: calc(100vh - 2rem);
		overflow-y: auto;
	}

	.wizard-help {
		margin: 0;
		font-size: 0.8125rem;
		line-height: 1.55;
		color: var(--text-secondary);
	}

	.wizard-field-help {
		margin: 0.375rem 0 0 0;
		font-size: 0.75rem;
		line-height: 1.5;
		color: var(--text-muted);
	}

	.wizard-inline-error {
		margin: 0.5rem 0 0 0;
		font-size: 0.8125rem;
		color: var(--danger);
	}

	.wizard-error {
		margin-top: 0.875rem;
		padding: 0.625rem 0.75rem;
		border-radius: var(--radius-md);
		border: 1px solid color-mix(in srgb, var(--danger) 32%, transparent);
		background: color-mix(in srgb, var(--danger) 5%, transparent);
	}

	.wizard-error-line {
		margin: 0 0 0.25rem 0;
		font-size: 0.8125rem;
		color: var(--danger);
	}

	.wizard-error-detail {
		margin: 0;
		padding: 0.4375rem 0.5625rem;
		border-radius: var(--radius-sm);
		background: var(--surface-code);
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.6875rem;
		line-height: 1.5;
		color: var(--text-secondary);
		overflow-wrap: anywhere;
	}

	.wizard-link-row {
		margin: 0.5rem 0 0 0;
	}

	.wizard-link {
		display: inline-flex;
		align-items: center;
		gap: 0.3125rem;
		font-size: 0.75rem;
		color: var(--accent);
		text-decoration: none;
	}

	.wizard-link:hover {
		text-decoration: underline;
	}

	.wizard-advanced {
		margin-top: 0.875rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border-subtle);
	}

	.wizard-foot {
		display: flex;
		flex-direction: column-reverse;
		gap: 0.5rem;
		margin-top: 1.25rem;
	}

	.wizard-foot-spacer {
		display: none;
	}

	@media (min-width: 40rem) {
		.wizard-foot {
			flex-direction: row;
			align-items: center;
		}

		.wizard-foot-spacer {
			display: block;
			flex: 1 1 auto;
		}
	}

	/* OAuth capability checkboxes — each says what it lets Alfy do, so the
	   consent decision is made here rather than on the provider's page. */
	.capability-choices {
		border: none;
		margin: 0;
		padding: 0;
	}

	.capability-choice {
		display: flex;
		align-items: flex-start;
		gap: 0.625rem;
		padding: 0.5625rem 0;
		border-top: 1px solid var(--border-subtle);
		cursor: pointer;
	}

	.capability-box {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.125rem;
		height: 1.125rem;
		margin-top: 0.0625rem;
		flex-shrink: 0;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border-default);
		background: var(--surface-page);
		color: var(--accent-contrast);
		transition: background var(--duration-standard), border-color var(--duration-standard);
	}

	.capability-box.checked {
		background: var(--accent);
		border-color: var(--accent);
	}

	.capability-choice:hover .capability-box:not(.checked) {
		border-color: var(--accent);
	}

	.capability-choice input:focus-visible + .capability-box {
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.capability-copy {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}

	.capability-name {
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--text-primary);
	}

	.capability-about {
		font-size: 0.75rem;
		line-height: 1.45;
		color: var(--text-muted);
	}

	/* Nextcloud waiting / blocked / connecting panels. */
	.waiting,
	.connecting {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		padding: 1.25rem 1rem;
		border-radius: var(--radius-lg);
		border: 1px solid var(--border-default);
		background: var(--surface-overlay);
	}

	.waiting-spinner,
	.connecting-spinner {
		display: inline-flex;
		color: var(--accent);
		animation: wizard-spin 1.1s linear infinite;
	}

	@keyframes wizard-spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.waiting-spinner,
		.connecting-spinner {
			animation-duration: 3s;
		}
	}

	.waiting-title,
	.connecting-title {
		margin: 0.625rem 0 0 0;
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.waiting-body {
		margin: 0.3125rem 0 0 0;
		font-size: 0.75rem;
		line-height: 1.5;
		color: var(--text-secondary);
		max-width: 22rem;
	}

	.connecting-hint {
		margin: 0.3125rem 0 0 0;
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	.waiting-expiry {
		display: inline-flex;
		align-items: center;
		gap: 0.3125rem;
		margin: 0.5625rem 0 0 0;
		font-size: 0.6875rem;
		color: var(--text-muted);
	}

	.blocked {
		display: flex;
		align-items: flex-start;
		gap: 0.625rem;
		padding: 0.75rem 0.875rem;
		border-radius: var(--radius-md);
		border: 1px solid color-mix(in srgb, var(--warning) 32%, transparent);
		background: color-mix(in srgb, var(--warning) 7%, transparent);
	}

	.blocked-icon {
		display: inline-flex;
		margin-top: 0.0625rem;
		flex-shrink: 0;
		color: var(--warning);
	}

	.blocked-body {
		margin: 0;
		font-size: 0.8125rem;
		line-height: 1.5;
		color: var(--text-secondary);
	}

	/* Mail path chooser. */
	.path-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.path-option {
		display: flex;
		align-items: center;
		gap: 0.6875rem;
		width: 100%;
		padding: 0.75rem 0.8125rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-page);
		text-align: left;
		cursor: pointer;
		transition: border-color var(--duration-standard), background var(--duration-standard);
	}

	.path-option:hover,
	.path-option:focus-visible {
		outline: none;
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 5%, var(--surface-page));
	}

	.path-mark {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		flex-shrink: 0;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border-default);
		background: var(--surface-overlay);
		color: var(--text-secondary);
	}

	.path-copy {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}

	.path-name {
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--text-primary);
	}

	.path-sub {
		font-size: 0.75rem;
		line-height: 1.45;
		color: var(--text-muted);
	}

	/* OwnTracks device picker. */
	.device-list {
		border: none;
		margin: 0;
		padding: 0;
	}

	.device-option {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.625rem 0;
		border-top: 1px solid var(--border-subtle);
		cursor: pointer;
	}

	.device-radio {
		width: 1rem;
		height: 1rem;
		flex-shrink: 0;
		border-radius: 9999px;
		border: 1px solid var(--border-default);
		background: var(--surface-page);
		transition: border var(--duration-standard);
	}

	.device-radio.checked {
		border: 5px solid var(--accent);
	}

	.device-option:hover .device-radio:not(.checked) {
		border-color: var(--accent);
	}

	.device-option input:focus-visible + .device-radio {
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.device-copy {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}

	.device-name {
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--text-primary);
	}

	.device-sub {
		font-size: 0.75rem;
		color: var(--text-muted);
	}
</style>
