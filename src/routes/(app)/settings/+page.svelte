<script lang="ts">
import { onMount } from "svelte";
import { get } from "svelte/store";
import { goto, invalidate } from "$app/navigation";
import PageSwitcher from "$lib/components/ui/PageSwitcher.svelte";
import ProfilePictureEditor from "$lib/components/ui/ProfilePictureEditor.svelte";
import { clearConversationSessionState } from "$lib/client/conversation-session";
import {
	clearMemoryAndKnowledge,
	clearWorkspaceData,
	deleteAccount,
	deleteAvatar,
	downloadAccountDataArchive,
	fetchAnalytics,
	saveBlobAsDownload,
	updateAdminConfig,
	updatePassword,
	updateProfile,
	updateUserPreferences,
	type AnalyticsResponse,
} from "$lib/client/api/settings";
import {
	fetchAdminUsers,
	fetchPublicPersonalityProfiles,
} from "$lib/client/api/admin";
import {
	disconnectConnection,
	fetchConnections,
	fetchLocality,
	recheckConnection,
	setLocalDistill,
	updateConnection,
	updateOwnTracksHome,
	type ConnectionPublic,
} from "$lib/client/api/connections";
import {
	getProviderCatalogEntry,
	type ConnectionProvider,
} from "$lib/client/connections/provider-catalog";
import { reconcileConversationSnapshot } from "$lib/stores/conversations";
import {
	avatarState,
	setAvatarRemoved,
	setAvatarUploaded,
} from "$lib/stores/avatar";
import { projects } from "$lib/stores/projects";
import {
	setSelectedModelAndSync,
	setModelPreferenceAndSync,
	setTitleLanguageAndSync,
	setUiLanguageAndSync,
	type TitleLanguage,
	type UiLanguage,
} from "$lib/stores/settings";
import { setThemeAndSync } from "$lib/stores/theme";
import { showToast } from "$lib/stores/toast";
import { currentConversationId } from "$lib/stores/ui";
import { t, type I18nKey } from "$lib/i18n";
import ConnectWizardModal from "./_components/ConnectWizardModal.svelte";
import PrivacyActionModal, {
	type PrivacyAction,
} from "./_components/PrivacyActionModal.svelte";
import SettingsAdministrationTab from "./_components/SettingsAdministrationTab.svelte";
import SettingsConnectionsTab from "./_components/SettingsConnectionsTab.svelte";
import SettingsProfileTab from "./_components/SettingsProfileTab.svelte";
import { getOAuthErrorReasonKey } from "./oauth-return";
import type { ModelId, UserModelPreference } from "$lib/model-types";
import type { PageProps } from "./$types";

// Extended data interface for admin-specific properties
interface SettingsPageData {
	userSettings: {
		id: string;
		email: string;
		name: string | null;
		role: "user" | "admin";
		preferences: {
			preferredModel: UserModelPreference;
			effectiveModel: ModelId;
			systemDefaultModel: ModelId;
			theme: "system" | "light" | "dark";
			titleLanguage: "auto" | "en" | "hu";
			uiLanguage: "en" | "hu";
			memoryEnabled?: boolean;
		};
		profilePicture: string | null;
	};
	currentConfigValues?: Record<string, string>;
	modelNames?: Record<string, string>;
	availableModels?: Array<{
		id: ModelId;
		displayName: string;
		iconUrl?: string | null;
		isThirdParty?: boolean;
	}>;
	envDefaults?: Record<string, string>;
	composerCommandRegistryEnabled?: boolean;
}

let { data }: PageProps = $props();
const getData = () => data;

type Tab = "profile" | "connections" | "administration";

const initialUserSettings = getData().userSettings;
const initialPreferences = initialUserSettings.preferences;
const initialCurrentConfigValues = (getData() as SettingsPageData)
	.currentConfigValues;
const isAdmin = initialUserSettings.role === "admin";
// ADR-0043 slice 18c: standalone Analytics tab removed for all users.
// Personal analytics merged into Profile ("Your Activity"); system analytics
// lives under Administration (admin-only). Only Profile is always shown.
const settingsTabs = $derived.by(() => {
	const tabs: Array<{ id: Tab; label: string }> = [
		{ id: "profile", label: $t("settingsProfile") },
		// Issue 7.1: visible to ALL users, not admin-gated (unlike Administration).
		{ id: "connections", label: $t("settingsConnections") },
	];
	if (isAdmin) {
		tabs.push({
			id: "administration",
			label: $t("settingsAdministration"),
		});
	}
	return tabs;
});
const modelNames = (getData() as SettingsPageData).modelNames ?? {
	model1: "Model 1",
	model2: "Model 2",
};
const availableModels = ((getData() as SettingsPageData).availableModels ?? [
	{ id: "model1", displayName: modelNames.model1, isThirdParty: false },
	{ id: "model2", displayName: modelNames.model2, isThirdParty: false },
]) as Array<{
	id: ModelId;
	displayName: string;
	iconUrl?: string | null;
	isThirdParty?: boolean;
}>;
const modelIcons = Object.fromEntries(
	availableModels.map((model) => [model.id, model.iconUrl ?? null]),
) as Record<string, string | null>;
const profileAvailableModels = $derived(
	availableModels.filter((model) => model.isThirdParty !== false),
);

let activeTab = $state<Tab>("profile");

let name = $state(initialUserSettings.name ?? "");
let email = $state(initialUserSettings.email);
let profileSaving = $state(false);

let currentPassword = $state("");
let newPassword = $state("");
let confirmPassword = $state("");
let passwordSaving = $state(false);
let showCurrentPw = $state(false);
let showNewPw = $state(false);
let showConfirmPw = $state(false);

let selectedModel = $state<UserModelPreference>(
	initialPreferences.preferredModel,
);
let effectiveModel = $state<ModelId>(initialPreferences.effectiveModel);
const systemDefaultModel =
	initialPreferences.systemDefaultModel ?? initialPreferences.effectiveModel;
let selectedTheme = $state(initialPreferences.theme);
let selectedTitleLanguage = $state(initialPreferences.titleLanguage ?? "auto");
let selectedUiLanguage = $state<UiLanguage>(
	initialPreferences.uiLanguage ?? "en",
);
let selectedPersonalityId = $state<string | null>(
	initialPreferences.preferredPersonalityId ?? null,
);
let selectedMemoryEnabled = $state<boolean>(
	initialPreferences.memoryEnabled ?? true,
);
let memorySaving = $state(false);
let personalityProfiles = $state<
	Array<{ id: string; name: string; description: string }>
>([]);

let privacyAction = $state<PrivacyAction | null>(null);
let privacyPassword = $state("");
let privacyError = $state("");
let privacyMessage = $state("");
let privacyLoading = $state(false);
let showPrivacyPw = $state(false);
const archiveLoading = $derived(privacyLoading && privacyAction === "archive");
const clearMemoryLoading = $derived(
	privacyLoading && privacyAction === "clearMemory",
);
const clearWorkspaceLoading = $derived(
	privacyLoading && privacyAction === "clearWorkspace",
);

let adminConfig = $state<Record<string, string>>(
	initialCurrentConfigValues ? { ...initialCurrentConfigValues } : {},
);
let adminSaving = $state(false);
let adminMessage = $state("");
let adminError = $state("");

// Auto-dismiss success messages after 4 seconds.
// B3: profile/password success+failure now route through the shared toast
// (see saveProfile/savePassword below) instead of this local field — the
// admin config pane is explicitly out of scope for that migration and keeps
// its own inline adminMessage/adminError feedback.
let messageTimers: ReturnType<typeof setTimeout>[] = [];
function showAdminMessage(text: string) {
	adminMessage = text;
	const timer = setTimeout(() => {
		adminMessage = "";
	}, 4000);
	messageTimers.push(timer);
}

let analyticsData = $state<AnalyticsResponse | null>(null);
let analyticsLoading = $state(false);
let analyticsError = $state("");
let analyticsMonth = $state<string | null>(null);
let systemAnalyticsMonth = $state<string | null>(null);
let excludedAnalyticsUserIds = $state<string[]>(parseExcludedUserIds());
let allAdminUsers = $state<
	Array<{ id: string; email: string; name: string | null }>
>([]);
let excludedUsersLoading = $state(false);
let showPictureEditor = $state(false);
let removingPhoto = $state(false);

// Issue 7.1 — Connections tab. Loaded lazily on first visit (see the
// $effect below), then mutated optimistically (mirrors changeMemoryEnabled).
let connections = $state<ConnectionPublic[]>([]);
let connectionsLoaded = $state(false);
let connectionsLoading = $state(false);
// Connections redesign — a failed load is its own state now. It used to
// render the same "No connections yet" card as a genuinely empty account,
// with a code comment saying the user could retry by revisiting the page.
let connectionsLoadFailed = $state(false);
// Issue 7.4 — Option A (local-distill) privacy toggle. Loaded alongside
// connections in the same lazy-load effect below, but tracked independently
// since it isn't part of the connections list.
let localDistill = $state(false);
let localityLoaded = $state(false);
let localityLoading = $state(false);
// Connections redesign — a locality read that failed is not the same answer
// as "off". See loadLocality() below.
let localityLoadFailed = $state(false);
// Raised by SettingsConnectionsTab's onStartConnect/onReconnect callback
// props; consumed by the ConnectWizardModal below (Issue 7.3).
let connectWizardProvider = $state<ConnectionProvider | null>(null);
let reconnectConnectionId = $state<string | null>(null);
// Connections redesign — capabilities the wizard should open pre-ticked,
// set by "Ask again" on a capability the provider denied. Empty means "use
// whatever the connection already has".
let wizardRequestedCapabilities = $state<string[]>([]);
// Non-null only while reconnectConnectionId is set — resolved from the
// already-loaded connections list so the wizard can prefill non-secret
// fields (server URL, email, ...) from the existing connection's config.
// Named distinctly from the reconnectConnection() handler function below
// (SettingsConnectionsTab's onReconnect callback prop).
const reconnectConnectionRecord = $derived(
	reconnectConnectionId
		? (connections.find((conn) => conn.id === reconnectConnectionId) ?? null)
		: null,
);
// Issue 7.3 — transient notice shown after the Google OAuth callback
// redirects back here (?connected=<provider> / ?error=<code>; see the
// onMount handler below and
// src/routes/api/oauth/google/callback/+server.ts).
// B3: routed through the shared toast only (previously also rendered an
// inline banner above the Connections tab, which duplicated the message).
function showConnectionsNotice(notice: {
	type: "success" | "error";
	provider?: string;
	reasonKey?: I18nKey;
}) {
	const message =
		notice.type === "success"
			? get(t)("connections.oauthReturn.success", {
					provider: getProviderCatalogEntry(notice.provider ?? "").displayName,
				})
			: get(t)("connections.oauthReturn.error", {
					reason: get(t)(
						notice.reasonKey ?? "connections.oauthReturn.reason.generic",
					),
				});
	showToast({ type: notice.type, message });
}

function parseExcludedUserIds(): string[] {
	const raw = initialCurrentConfigValues?.ANALYTICS_EXCLUDED_USER_IDS;
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed) && parsed.every((id) => typeof id === "string")) {
			return parsed;
		}
	} catch {
		// not valid JSON, return empty
	}
	return [];
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function loadAnalytics(
	month?: string | null,
	timeline: string | null = "weekly",
	systemMonth: string | null = systemAnalyticsMonth,
) {
	analyticsLoading = true;
	analyticsError = "";
	try {
		analyticsData = await fetchAnalytics(
			import.meta.env.DEV,
			month ?? undefined,
			timeline ?? undefined,
			systemMonth ?? undefined,
		);
	} catch (error: unknown) {
		analyticsError = errorMessage(error);
	} finally {
		analyticsLoading = false;
	}
}

async function handleMonthChange(month: string | null) {
	analyticsMonth = month;
	systemAnalyticsMonth = month;
	await loadAnalytics(month, "weekly", month);
}

async function handleTimelineChange(granularity: string) {
	await loadAnalytics(analyticsMonth, granularity, systemAnalyticsMonth);
}

async function handleSystemMonthChange(month: string | null) {
	analyticsMonth = month;
	systemAnalyticsMonth = month;
	await loadAnalytics(month, "weekly", month);
}

async function loadAllAdminUsers() {
	if (!isAdmin) return;
	excludedUsersLoading = true;
	try {
		const users = await fetchAdminUsers();
		const activeUsers = users.map((u) => ({
			id: u.id,
			email: u.email,
			name: u.name,
		}));
		const activeIds = new Set(activeUsers.map((u) => u.id));
		const historicalUsers = (analyticsData?.analyticsUsers ?? [])
			.filter((u) => !activeIds.has(u.userId))
			.map((u) => ({
				id: u.userId,
				email: u.email ?? "",
				name: u.name ?? u.email ?? u.userId,
			}));
		allAdminUsers = [...activeUsers, ...historicalUsers];
	} catch {
		// non-fatal
	} finally {
		excludedUsersLoading = false;
	}
}

async function handleExcludedUsersChange(userIds: string[]) {
	excludedAnalyticsUserIds = userIds;
	await updateAdminConfig({
		ANALYTICS_EXCLUDED_USER_IDS: JSON.stringify(userIds),
		...adminConfig,
	});
	adminConfig = {
		...adminConfig,
		ANALYTICS_EXCLUDED_USER_IDS: JSON.stringify(userIds),
	};
	await loadAnalytics(analyticsMonth, "weekly", systemAnalyticsMonth);
}

async function removePhoto() {
	removingPhoto = true;
	try {
		await deleteAvatar();
		setAvatarRemoved();
	} catch {
		// Non-fatal
	} finally {
		removingPhoto = false;
	}
}

async function saveProfile() {
	profileSaving = true;
	try {
		await updateProfile({ name: name.trim() || null, email });
		showToast({ type: "success", message: $t("settings_profileUpdated") });
	} catch (error: unknown) {
		showToast({ type: "error", message: errorMessage(error) });
	} finally {
		profileSaving = false;
	}
}

async function savePassword() {
	if (newPassword !== confirmPassword) {
		showToast({ type: "error", message: $t("settings_passwordMismatch") });
		return;
	}
	if (newPassword.length < 8) {
		showToast({
			type: "error",
			message: $t("settings_passwordTooShort"),
		});
		return;
	}
	passwordSaving = true;
	try {
		await updatePassword({ currentPassword, newPassword });
		showToast({ type: "success", message: $t("settings_passwordChanged") });
		currentPassword = "";
		newPassword = "";
		confirmPassword = "";
	} catch (error: unknown) {
		showToast({ type: "error", message: errorMessage(error) });
	} finally {
		passwordSaving = false;
	}
}

async function changePersonality(id: string | null) {
	selectedPersonalityId = id;
	await updateUserPreferences({ preferredPersonalityId: id }).catch(() => {});
}

async function changeModel(model: UserModelPreference) {
	selectedModel = model;
	effectiveModel = model ?? systemDefaultModel;
	if (model === null) {
		await setModelPreferenceAndSync(null, systemDefaultModel);
	} else {
		await setSelectedModelAndSync(model);
	}
}

async function changeTheme(theme: "system" | "light" | "dark") {
	selectedTheme = theme;
	await setThemeAndSync(theme);
}

async function changeTitleLanguage(lang: TitleLanguage) {
	selectedTitleLanguage = lang;
	await setTitleLanguageAndSync(lang);
}

async function changeUiLanguage(lang: UiLanguage) {
	selectedUiLanguage = lang;
	await setUiLanguageAndSync(lang);
}

// Deep-link from the Knowledge memory empty state (/settings?section=memory):
// bring the Profile tab forward and scroll the Memory card into view. Also
// handles the Google OAuth callback's return to
// /settings?section=connections&connected=<provider> (or &error=<code>) —
// see src/routes/api/oauth/google/callback/+server.ts for the exact param
// names/values this reads.
onMount(() => {
	if (typeof window === "undefined") return;
	const params = new URLSearchParams(window.location.search);
	const section = params.get("section");

	if (section === "memory") {
		activeTab = "profile";
		requestAnimationFrame(() => {
			const card = document.getElementById("settings-memory-card");
			if (!card) return;
			card.scrollIntoView({ behavior: "smooth", block: "center" });
			card.classList.add("settings-card-highlight");
			setTimeout(() => card.classList.remove("settings-card-highlight"), 2000);
		});
		return;
	}

	// Connections redesign — the "not set up on this server yet" wizard state
	// links here rather than telling a single-user server's owner to ask their
	// administrator, who is the same person. Mirrors the tool-health handler
	// below; the card highlight is best-effort so this still lands the user on
	// Administration → System even before that card grows an id.
	if (section === "integrations" && isAdmin) {
		void handleTabChange("administration");
		requestAnimationFrame(() => {
			const card = document.getElementById("settings-integrations-card");
			if (!card) return;
			card.scrollIntoView({ behavior: "smooth", block: "start" });
			card.classList.add("settings-card-highlight");
			setTimeout(() => card.classList.remove("settings-card-highlight"), 2000);
		});
		return;
	}

	if (section === "tool-health" && isAdmin) {
		void handleTabChange("administration");
		requestAnimationFrame(() => {
			const card = document.getElementById("settings-tool-health-card");
			if (!card) return;
			card.scrollIntoView({ behavior: "smooth", block: "start" });
			card.classList.add("settings-card-highlight");
			setTimeout(() => card.classList.remove("settings-card-highlight"), 2000);
		});
		return;
	}

	if (section !== "connections") return;
	activeTab = "connections";

	const connectedProvider = params.get("connected");
	const oauthErrorCode = params.get("error");
	if (connectedProvider) {
		void loadConnections();
		showConnectionsNotice({ type: "success", provider: connectedProvider });
	} else if (oauthErrorCode) {
		showConnectionsNotice({
			type: "error",
			reasonKey: getOAuthErrorReasonKey(oauthErrorCode),
		});
	}
	if (connectedProvider || oauthErrorCode) {
		// Strip only the params this handler consumed (section/connected/error)
		// so any other query params the URL arrived with survive the redirect
		// cleanup — e.g. a hypothetical ?debug=1 tacked on by the caller.
		params.delete("section");
		params.delete("connected");
		params.delete("error");
		const remaining = params.toString();
		const nextUrl =
			window.location.pathname + (remaining ? `?${remaining}` : "");
		window.history.replaceState(null, "", nextUrl);
	}
});

async function changeMemoryEnabled(enabled: boolean) {
	const previous = selectedMemoryEnabled;
	selectedMemoryEnabled = enabled;
	memorySaving = true;
	try {
		await updateUserPreferences({ memoryEnabled: enabled });
	} catch {
		// Revert the optimistic switch if the write fails.
		selectedMemoryEnabled = previous;
	} finally {
		memorySaving = false;
	}
}

// Issue 7.1 — Connections tab handlers. Each toggle flips local state
// optimistically then persists via updateConnection, reverting on failure
// (mirrors changeMemoryEnabled above). onDisconnect removes the row from
// local state only after the DELETE succeeds (no optimistic removal —
// there's nothing sensible to "revert" a vanished card back to).
//
// Connections redesign — every one of these now RE-THROWS after reverting.
// The revert is still what keeps the UI honest; the throw is what lets
// SettingsConnectionsTab tell the user which change didn't save and offer to
// try it again. Swallowing was the single biggest source of silent failure on
// this screen.
async function loadConnections() {
	connectionsLoading = true;
	try {
		connections = await fetchConnections();
		connectionsLoadFailed = false;
	} catch {
		// The tab renders its own "we couldn't load your connections" card with
		// a retry — distinct from a genuinely empty account.
		connectionsLoadFailed = true;
	} finally {
		connectionsLoading = false;
		connectionsLoaded = true;
	}
}

// Issue 7.4 — Option A. Loaded alongside connections (see the $effect
// below); toggled optimistically with revert-on-failure (mirrors the
// connection toggle handlers below).
async function loadLocality() {
	localityLoading = true;
	try {
		const result = await fetchLocality();
		localDistill = result.localDistill;
		localityLoadFailed = false;
	} catch {
		// Connections redesign — this used to swallow with a comment saying
		// the user could retry by revisiting the tab. The switch then showed
		// "off" — a definite answer about where their data goes — when the
		// truth was that we had no idea. The card now says so and offers the
		// one action that fixes it.
		localityLoadFailed = true;
	} finally {
		localityLoading = false;
		localityLoaded = true;
	}
}

async function toggleLocalDistill(next: boolean) {
	const previous = localDistill;
	localDistill = next;
	try {
		await setLocalDistill(next);
	} catch (err) {
		localDistill = previous;
		throw err;
	}
}

function patchConnectionLocal(id: string, patch: Partial<ConnectionPublic>) {
	connections = connections.map((conn) =>
		conn.id === id ? { ...conn, ...patch } : conn,
	);
}

async function toggleConnectionCapability(
	id: string,
	capability: string,
	next: boolean,
) {
	const previous = connections.find((conn) => conn.id === id)?.capabilities;
	if (!previous) return;
	const nextCapabilities = next
		? [...previous, capability]
		: previous.filter((cap) => cap !== capability);
	patchConnectionLocal(id, { capabilities: nextCapabilities });
	try {
		await updateConnection(id, { capabilities: nextCapabilities });
	} catch (err) {
		patchConnectionLocal(id, { capabilities: previous });
		throw err;
	}
}

async function toggleConnectionAllowWrites(id: string, next: boolean) {
	const previous = connections.find((conn) => conn.id === id)?.allowWrites;
	if (previous === undefined) return;
	patchConnectionLocal(id, { allowWrites: next });
	try {
		await updateConnection(id, { allowWrites: next });
	} catch (err) {
		patchConnectionLocal(id, { allowWrites: previous });
		throw err;
	}
}

async function toggleConnectionDefaultOn(id: string, next: boolean) {
	const previous = connections.find((conn) => conn.id === id)?.defaultOn;
	if (previous === undefined) return;
	patchConnectionLocal(id, { defaultOn: next });
	try {
		await updateConnection(id, { defaultOn: next });
	} catch (err) {
		patchConnectionLocal(id, { defaultOn: previous });
		throw err;
	}
}

async function updateConnectionWriteAllowlist(id: string, next: string[]) {
	const previous = connections.find((conn) => conn.id === id)?.writeAllowlist;
	if (!previous) return;
	patchConnectionLocal(id, { writeAllowlist: next });
	try {
		await updateConnection(id, { writeAllowlist: next });
	} catch (err) {
		patchConnectionLocal(id, { writeAllowlist: previous });
		throw err;
	}
}

// Task 10 — sets/clears the OwnTracks connection's saved home lat/lon.
// Mirrors the optimistic-update/revert-on-failure pattern above, but patches
// the nested `config` object (merging in/deleting homeLat/homeLon) rather
// than a top-level field, since that's where the server stores it.
async function updateConnectionOwnTracksHome(
	id: string,
	next: { homeLat: number | null; homeLon: number | null },
) {
	const target = connections.find((conn) => conn.id === id);
	if (!target) return;
	const previousConfig = target.config;
	const nextConfig: Record<string, unknown> = { ...previousConfig };
	if (next.homeLat === null || next.homeLon === null) {
		delete nextConfig.homeLat;
		delete nextConfig.homeLon;
	} else {
		nextConfig.homeLat = next.homeLat;
		nextConfig.homeLon = next.homeLon;
	}
	patchConnectionLocal(id, { config: nextConfig });
	try {
		await updateOwnTracksHome(id, next);
	} catch (err) {
		patchConnectionLocal(id, { config: previousConfig });
		throw err;
	}
}

async function disconnectConnectionById(id: string) {
	// No try/catch: a failed disconnect must reach the caller, which keeps the
	// dialog open and says the row is still there. It used to be swallowed
	// with a comment saying "card stays put so the user can retry" — with
	// nothing on screen telling them there was anything to retry.
	await disconnectConnection(id);
	connections = connections.filter((conn) => conn.id !== id);
}

// Connections redesign — asks the provider whether one connection still
// works and folds the answer back into the list.
//
// This is what finally calls checkConnectionHealth (health.ts), which had
// never had a caller: status was only ever written as a side effect of a
// provider read during a chat turn, so a revoked token read "Connected" on
// this tab until a question happened to need it. The tab fires this when a
// detail dialog opens — the moment the user is asking about that account —
// rather than one network call per provider on every visit.
async function recheckConnectionHealth(id: string) {
	// Deliberately quiet on failure: the user asked to LOOK at a connection,
	// not to change one, and a check that could not run has changed nothing
	// and lost nothing. The row keeps the last status we knew. A recovery card
	// here would be a message about our own bookkeeping.
	try {
		const fresh = await recheckConnection(id);
		patchConnectionLocal(id, {
			status: fresh.status,
			statusDetail: fresh.statusDetail,
			statusChangedAt: fresh.statusChangedAt,
			lastUsedAt: fresh.lastUsedAt,
		});
	} catch {
		// Intentionally ignored — see above.
	}
}

function startConnect(provider: ConnectionProvider) {
	reconnectConnectionId = null;
	wizardRequestedCapabilities = [];
	connectWizardProvider = provider;
}

function reconnectConnection(connectionId: string) {
	const target = connections.find((conn) => conn.id === connectionId);
	reconnectConnectionId = connectionId;
	wizardRequestedCapabilities = [];
	connectWizardProvider = (target?.provider as ConnectionProvider) ?? null;
}

// Connections redesign — "Ask again" on a capability the provider denied.
// Re-opens the same wizard in reconnect mode with the denied capability
// pre-ticked alongside everything already granted, so the consent screen is
// asked for the union rather than silently narrowing what already works.
function askAgainForCapability(connectionId: string, capability: string) {
	const target = connections.find((conn) => conn.id === connectionId);
	if (!target) return;
	reconnectConnectionId = connectionId;
	wizardRequestedCapabilities = [
		...new Set([...(target.grantedCapabilities ?? []), capability]),
	];
	connectWizardProvider = target.provider as ConnectionProvider;
}

function closeConnectWizard() {
	connectWizardProvider = null;
	reconnectConnectionId = null;
	wizardRequestedCapabilities = [];
}

function handleConnectWizardConnected() {
	void loadConnections();
}

// Connections redesign — takes the user to the Administration page that owns
// the integration keys, from inside the wizard's "not set up yet" state.
// An in-app navigation rather than a link so the tab switch is instant and
// the connect dialog's own close still runs.
function openAdminIntegrations() {
	closeConnectWizard();
	if (!isAdmin) return;
	void handleTabChange("administration");
	requestAnimationFrame(() => {
		const card = document.getElementById("settings-integrations-card");
		if (!card) return;
		card.scrollIntoView({ behavior: "smooth", block: "start" });
		card.classList.add("settings-card-highlight");
		setTimeout(() => card.classList.remove("settings-card-highlight"), 2000);
	});
}

function openPrivacyAction(action: PrivacyAction) {
	privacyAction = action;
	privacyPassword = "";
	privacyError = "";
	privacyMessage = "";
	showPrivacyPw = false;
}

function closePrivacyAction() {
	privacyAction = null;
	privacyPassword = "";
	privacyError = "";
	showPrivacyPw = false;
}

function clearWorkspaceClientState() {
	reconcileConversationSnapshot([], { resetLocalState: true });
	projects.set([]);
	currentConversationId.set(null);
	clearConversationSessionState();
	analyticsData = null;
	analyticsError = "";
}

async function downloadArchive(password: string) {
	const archive = await downloadAccountDataArchive(password);
	saveBlobAsDownload(archive.blob, archive.filename);
}

async function confirmPrivacyAction() {
	if (!privacyAction) return;
	privacyError = "";
	privacyLoading = true;
	const action = privacyAction;
	try {
		if (action === "archive") {
			await downloadArchive(privacyPassword);
			privacyMessage = $t("settings_archiveDownloaded");
			closePrivacyAction();
			return;
		}
		if (action === "clearMemory") {
			await clearMemoryAndKnowledge(privacyPassword);
			privacyMessage = $t("settings_clearMemorySuccess");
			closePrivacyAction();
			return;
		}
		if (action === "clearWorkspace") {
			await clearWorkspaceData(privacyPassword);
			clearWorkspaceClientState();
			closePrivacyAction();
			await goto("/login");
			return;
		}
		await deleteAccount(privacyPassword);
		clearWorkspaceClientState();
		closePrivacyAction();
		await goto("/login");
	} catch (error: unknown) {
		privacyError = errorMessage(error);
	} finally {
		privacyLoading = false;
	}
}

async function downloadArchiveFromDestructiveModal() {
	if (!privacyPassword || privacyLoading) return;
	privacyError = "";
	privacyLoading = true;
	try {
		await downloadArchive(privacyPassword);
		privacyMessage = $t("settings_archiveDownloaded");
	} catch (error: unknown) {
		privacyError = errorMessage(error);
	} finally {
		privacyLoading = false;
	}
}

async function saveAdminConfig() {
	adminSaving = true;
	adminMessage = "";
	adminError = "";
	try {
		const configToSave = { ...adminConfig };
		if (configToSave.WEB_PUSH_VAPID_PRIVATE_KEY === "[set]") {
			delete configToSave.WEB_PUSH_VAPID_PRIVATE_KEY;
		}
		await updateAdminConfig(configToSave);
		await invalidate("app:shell");
		showAdminMessage("Configuration saved.");
	} catch (error: unknown) {
		adminError = errorMessage(error);
	} finally {
		adminSaving = false;
	}
}

async function handleTabChange(tab: Tab) {
	activeTab = tab;
	if (
		tab === "administration" &&
		isAdmin &&
		!analyticsData &&
		!analyticsLoading
	) {
		await loadAnalytics();
	}
	if (tab === "administration" && isAdmin) {
		void loadAllAdminUsers();
	}
}

function handlePageSwitcherChange(tab: string) {
	if (tab === "profile" || tab === "connections" || tab === "administration") {
		void handleTabChange(tab);
	}
}

$effect(() => {
	if (
		activeTab === "connections" &&
		!connectionsLoaded &&
		!connectionsLoading
	) {
		void loadConnections();
	}
	if (activeTab === "connections" && !localityLoaded && !localityLoading) {
		void loadLocality();
	}
	if (activeTab === "profile" && personalityProfiles.length === 0) {
		void fetchPublicPersonalityProfiles()
			.then((profiles) => {
				personalityProfiles = profiles;
				if (
					selectedPersonalityId &&
					!profiles.some((profile) => profile.id === selectedPersonalityId)
				) {
					selectedPersonalityId = null;
					void updateUserPreferences({ preferredPersonalityId: null }).catch(
						() => {},
					);
				}
			})
			.catch(() => {});
	}
	// ADR-0043 slice 18c: personal analytics ("Your Activity") lives in Profile
	// now — load it once on first Profile entry so the section has data.
	if (activeTab === "profile" && !analyticsData && !analyticsLoading) {
		void loadAnalytics();
	}
});
</script>

<div class="flex h-full min-h-0 w-full flex-1 flex-col overflow-y-auto">
	<div class="settings-shell mx-auto w-full px-4 py-8" class:settings-shell-admin={activeTab === 'administration' && isAdmin}>
		<h1 class="mb-6 text-2xl font-semibold text-text-primary">{$t('settings')}</h1>

		{#if settingsTabs.length > 1}
			<div class="mb-6">
				<PageSwitcher
					items={settingsTabs}
					activeId={activeTab}
					ariaLabel={$t('settings')}
					onChange={handlePageSwitcherChange}
				/>
			</div>
		{/if}

		{#if activeTab === 'profile'}
			<SettingsProfileTab
				userId={data.userSettings.id}
				userDisplayName={data.userSettings.name ?? data.userSettings.email}
				userEmail={data.userSettings.email}
				profilePicture={$avatarState.profilePicture}
				cacheBuster={$avatarState.cacheBuster}
				{removingPhoto}
				onOpenPictureEditor={() => (showPictureEditor = true)}
				onRemovePhoto={removePhoto}
				bind:name
				bind:email
				{profileSaving}
				onSaveProfile={saveProfile}
				bind:currentPassword
				bind:newPassword
				bind:confirmPassword
				bind:showCurrentPw
				bind:showNewPw
				bind:showConfirmPw
				{passwordSaving}
				onSavePassword={savePassword}
				availableModels={profileAvailableModels}
				{selectedModel}
				{effectiveModel}
				{systemDefaultModel}
				{selectedTheme}
				{selectedTitleLanguage}
				{selectedUiLanguage}
				onChangeModel={changeModel}
				onChangeTheme={changeTheme}
				onChangeTitleLanguage={changeTitleLanguage}
				onChangeUiLanguage={changeUiLanguage}
				memoryEnabled={selectedMemoryEnabled}
				{memorySaving}
				onChangeMemoryEnabled={changeMemoryEnabled}
				{personalityProfiles}
				{selectedPersonalityId}
				onChangePersonality={changePersonality}
				onOpenDownloadArchive={() => openPrivacyAction('archive')}
				onOpenClearMemory={() => openPrivacyAction('clearMemory')}
				onOpenClearWorkspace={() => openPrivacyAction('clearWorkspace')}
				onOpenDeleteModal={() => openPrivacyAction('deleteAccount')}
				{archiveLoading}
				{clearMemoryLoading}
				{clearWorkspaceLoading}
				privacyControlsError={privacyError}
				privacyControlsMessage={privacyMessage}
				skillsEnabled={(data as SettingsPageData).composerCommandRegistryEnabled ?? false}
				projects={$projects}
				personalAnalyticsData={analyticsData}
				personalAnalyticsLoading={analyticsLoading}
				personalAnalyticsError={analyticsError}
				{modelNames}
				{modelIcons}
				onRetryPersonalAnalytics={loadAnalytics}
				selectedPersonalMonth={analyticsMonth}
				onPersonalMonthChange={handleMonthChange}
				onPersonalTimelineChange={handleTimelineChange}
			/>
		{/if}

		{#if activeTab === 'connections'}
			<SettingsConnectionsTab
				{connections}
				loading={connectionsLoading && !connectionsLoaded}
				loadFailed={connectionsLoadFailed}
				onRetryLoad={loadConnections}
				onToggleCapability={toggleConnectionCapability}
				onToggleAllowWrites={toggleConnectionAllowWrites}
				onToggleDefaultOn={toggleConnectionDefaultOn}
				onUpdateWriteAllowlist={updateConnectionWriteAllowlist}
				onUpdateOwnTracksHome={updateConnectionOwnTracksHome}
				onDisconnect={disconnectConnectionById}
				onRecheck={recheckConnectionHealth}
				onStartConnect={startConnect}
				onReconnect={reconnectConnection}
				onAskAgain={askAgainForCapability}
				{localDistill}
				localityLoading={localityLoading && !localityLoaded}
				{localityLoadFailed}
				onRetryLocality={loadLocality}
				onToggleLocalDistill={toggleLocalDistill}
			/>
		{/if}

		{#if connectWizardProvider}
			<ConnectWizardModal
				provider={connectWizardProvider}
				{reconnectConnectionId}
				reconnectConnection={reconnectConnectionRecord}
				requestedCapabilities={wizardRequestedCapabilities}
				{isAdmin}
				onOpenAdminIntegrations={openAdminIntegrations}
				onClose={closeConnectWizard}
				onConnected={handleConnectWizardConnected}
			/>
		{/if}

		{#if activeTab === 'administration' && isAdmin}
			<SettingsAdministrationTab
				currentUserId={data.userSettings.id}
				{modelNames}
				{availableModels}
				bind:adminConfig
				envDefaults={(data as SettingsPageData).envDefaults ?? {}}
				{adminSaving}
				{adminMessage}
				{adminError}
				onSaveAdminConfig={saveAdminConfig}
				systemAnalyticsData={analyticsData}
				systemAnalyticsLoading={analyticsLoading}
				systemAnalyticsError={analyticsError}
				{modelIcons}
				onRetrySystemAnalytics={loadAnalytics}
				selectedSystemMonth={systemAnalyticsMonth}
				onSystemMonthChange={handleSystemMonthChange}
				systemAnalyticsUsers={allAdminUsers}
				excludedUserIds={excludedAnalyticsUserIds}
				onExcludedUsersChange={handleExcludedUsersChange}
			/>
		{/if}
	</div>
</div>

{#if showPictureEditor}
	<ProfilePictureEditor
		onClose={() => (showPictureEditor = false)}
		onUploaded={() => {
			setAvatarUploaded(data.userSettings.id);
			showPictureEditor = false;
		}}
	/>
{/if}

{#if privacyAction}
	<PrivacyActionModal
		action={privacyAction}
		bind:password={privacyPassword}
		error={privacyError}
		loading={privacyLoading}
		bind:showPassword={showPrivacyPw}
		onConfirm={confirmPrivacyAction}
		onCancel={closePrivacyAction}
		onDownloadArchive={downloadArchiveFromDestructiveModal}
	/>
{/if}

<style>
	:global(.settings-card) {
		background: var(--surface-overlay);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		padding: var(--space-lg);
	}

	:global(.settings-card-danger) {
		border-color: var(--danger);
	}

	:global(.settings-section-title) {
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--text-primary);
		margin-bottom: var(--space-md);
	}

	:global(.settings-label) {
		display: block;
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--text-secondary);
		margin-bottom: 0.25rem;
	}

	:global(.settings-input) {
		width: 100%;
		background: var(--surface-page);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		padding: 0.5rem 0.75rem;
		font-size: 0.875rem;
		color: var(--text-primary);
		transition: border-color var(--duration-standard);
		resize: vertical;
	}

	:global(.settings-input:focus) {
		outline: none;
		border-color: var(--accent);
	}

	:global(.pref-pill) {
		padding: 0.375rem 0.875rem;
		border-radius: var(--radius-full);
		border: 1px solid var(--border-default);
		font-size: 0.8125rem;
		color: var(--text-secondary);
		background: var(--surface-page);
		cursor: pointer;
		transition: all var(--duration-standard);
	}

	:global(.pref-pill:hover) {
		border-color: var(--accent);
		color: var(--text-primary);
	}

	:global(.pref-pill-active) {
		border-color: var(--accent);
		color: var(--accent);
		background: color-mix(in srgb, var(--accent) 10%, var(--surface-page) 90%);
		font-weight: 500;
	}

	:global(.settings-card-highlight) {
		box-shadow: 0 0 0 2px var(--accent);
		transition: box-shadow var(--duration-standard) var(--ease-out);
	}

	:global(.toggle-btn) {
		position: relative;
		width: 44px;
		height: 24px;
		background: var(--border-default);
		border-radius: 9999px;
		border: none;
		cursor: pointer;
		transition: background var(--duration-standard);
		flex-shrink: 0;
	}

	:global(.toggle-btn.toggle-on) {
		background: var(--accent);
	}

	:global(.toggle-thumb) {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 20px;
		height: 20px;
		background: white;
		border-radius: 9999px;
		transition: transform var(--duration-standard);
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
	}

	:global(.toggle-on .toggle-thumb) {
		transform: translateX(20px);
	}

	:global(.stat-card) {
		background: var(--surface-page);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		padding: 0.75rem;
	}

	:global(.stat-value) {
		font-size: 1.25rem;
		font-weight: 600;
		color: var(--text-primary);
		line-height: 1.2;
	}

	:global(.stat-label) {
		font-size: 0.75rem;
		color: var(--text-muted);
		margin-top: 0.25rem;
	}

	:global(.stat-card--hero) {
		background: var(--surface-page);
		border: 1px solid var(--accent);
		border-radius: var(--radius-md);
		padding: 0.75rem;
	}

	:global(.stat-value-hero) {
		font-size: 1.5rem;
		font-weight: 700;
		color: var(--accent);
		line-height: 1.1;
	}

	:global(.stat-comparison) {
		font-size: 0.7rem;
		color: var(--text-muted);
		margin-top: 0.35rem;
	}

	:global(.month-label) {
		font-size: 0.82rem;
		font-weight: 500;
		color: var(--text-primary);
		min-width: 7rem;
		text-align: center;
	}

	:global(.month-nav-btn) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-full);
		background: var(--surface-page);
		color: var(--text-secondary);
		font-size: 0.75rem;
		cursor: pointer;
		transition: border-color var(--duration-standard);
	}

	:global(.month-nav-btn:hover:not(:disabled)) {
		border-color: var(--accent);
		color: var(--accent);
	}

	:global(.month-nav-btn:disabled) {
		opacity: 0.35;
		cursor: default;
	}

	:global(.month-alltime-btn) {
		margin-left: 0.5rem;
		font-size: 0.72rem;
		color: var(--text-muted);
		cursor: pointer;
		border: none;
		background: none;
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	:global(.month-alltime-btn:hover) {
		color: var(--accent);
	}

	:global(.timeline-toggle-btn) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 26px;
		border: none;
		border-radius: var(--radius-full);
		background: transparent;
		color: var(--text-muted);
		font-size: 0.72rem;
		font-weight: 500;
		cursor: pointer;
		transition: background var(--duration-standard), color var(--duration-standard);
	}

	:global(.timeline-toggle-btn--active) {
		background: var(--accent);
		color: #fff;
	}

	.settings-shell {
		max-width: 672px;
	}

	.settings-shell-admin {
		max-width: 1440px;
		padding-left: var(--space-lg);
		padding-right: var(--space-lg);
	}

	@media (max-width: 768px) {
		.settings-shell-admin {
			padding-left: var(--space-md);
			padding-right: var(--space-md);
		}
	}
</style>
