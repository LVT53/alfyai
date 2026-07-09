<script lang="ts">
import { onMount } from "svelte";
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
	updateConnection,
	type ConnectionPublic,
} from "$lib/client/api/connections";
import type { ConnectionProvider } from "$lib/client/connections/provider-catalog";
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
import { currentConversationId } from "$lib/stores/ui";
import { t } from "$lib/i18n";
import { AVATAR_COLORS, AVATAR_COUNT } from "$lib/utils/avatar";
import PrivacyActionModal, {
	type PrivacyAction,
} from "./_components/PrivacyActionModal.svelte";
import SettingsAdministrationTab from "./_components/SettingsAdministrationTab.svelte";
import SettingsConnectionsTab from "./_components/SettingsConnectionsTab.svelte";
import SettingsProfileTab from "./_components/SettingsProfileTab.svelte";
import type { ModelId, UserModelPreference } from "$lib/types";
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
			avatarId: number | null;
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
let profileMessage = $state("");
let profileError = $state("");

let currentPassword = $state("");
let newPassword = $state("");
let confirmPassword = $state("");
let passwordSaving = $state(false);
let passwordMessage = $state("");
let passwordError = $state("");
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
let selectedAvatar = $state<number | null>(initialPreferences.avatarId);
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

// Auto-dismiss success messages after 4 seconds
let messageTimers: ReturnType<typeof setTimeout>[] = [];
function showMessage(
	field: "profileMessage" | "passwordMessage" | "adminMessage",
	text: string,
) {
	if (field === "profileMessage") profileMessage = text;
	else if (field === "passwordMessage") passwordMessage = text;
	else adminMessage = text;
	const timer = setTimeout(() => {
		if (field === "profileMessage") profileMessage = "";
		else if (field === "passwordMessage") passwordMessage = "";
		else adminMessage = "";
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
let showAvatarPicker = $state(false);
let showPictureEditor = $state(false);
let removingPhoto = $state(false);

// Issue 7.1 — Connections tab. Loaded lazily on first visit (see the
// $effect below), then mutated optimistically (mirrors changeMemoryEnabled).
let connections = $state<ConnectionPublic[]>([]);
let connectionsLoaded = $state(false);
let connectionsLoading = $state(false);
// Raised by SettingsConnectionsTab's onStartConnect/onReconnect callback
// props; consumed by the connect wizard modal built in Issue 7.3. 7.1 only
// sets this intent state, it does not render a wizard.
let connectWizardProvider = $state<ConnectionProvider | null>(null);
let reconnectConnectionId = $state<string | null>(null);

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
	profileMessage = "";
	profileError = "";
	try {
		await updateProfile({ name: name.trim() || null, email });
		showMessage("profileMessage", "Profile updated.");
	} catch (error: unknown) {
		profileError = errorMessage(error);
	} finally {
		profileSaving = false;
	}
}

async function savePassword() {
	passwordError = "";
	passwordMessage = "";
	if (newPassword !== confirmPassword) {
		passwordError = "New passwords do not match.";
		return;
	}
	if (newPassword.length < 8) {
		passwordError = "Password must be at least 8 characters.";
		return;
	}
	passwordSaving = true;
	try {
		await updatePassword({ currentPassword, newPassword });
		showMessage("passwordMessage", "Password changed.");
		currentPassword = "";
		newPassword = "";
		confirmPassword = "";
	} catch (error: unknown) {
		passwordError = errorMessage(error);
	} finally {
		passwordSaving = false;
	}
}

async function selectAvatar(avatarId: number) {
	selectedAvatar = avatarId;
	await updateUserPreferences({ avatarId }).catch(() => {});
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
// bring the Profile tab forward and scroll the Memory card into view.
onMount(() => {
	if (typeof window === "undefined") return;
	const section = new URLSearchParams(window.location.search).get("section");
	if (section !== "memory") return;
	activeTab = "profile";
	requestAnimationFrame(() => {
		const card = document.getElementById("settings-memory-card");
		if (!card) return;
		card.scrollIntoView({ behavior: "smooth", block: "center" });
		card.classList.add("settings-card-highlight");
		setTimeout(() => card.classList.remove("settings-card-highlight"), 2000);
	});
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
async function loadConnections() {
	connectionsLoading = true;
	try {
		connections = await fetchConnections();
	} catch {
		// Non-fatal: panel shows an empty list; user can retry by revisiting.
	} finally {
		connectionsLoading = false;
		connectionsLoaded = true;
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
	} catch {
		patchConnectionLocal(id, { capabilities: previous });
	}
}

async function toggleConnectionAllowWrites(id: string, next: boolean) {
	const previous = connections.find((conn) => conn.id === id)?.allowWrites;
	if (previous === undefined) return;
	patchConnectionLocal(id, { allowWrites: next });
	try {
		await updateConnection(id, { allowWrites: next });
	} catch {
		patchConnectionLocal(id, { allowWrites: previous });
	}
}

async function toggleConnectionDefaultOn(id: string, next: boolean) {
	const previous = connections.find((conn) => conn.id === id)?.defaultOn;
	if (previous === undefined) return;
	patchConnectionLocal(id, { defaultOn: next });
	try {
		await updateConnection(id, { defaultOn: next });
	} catch {
		patchConnectionLocal(id, { defaultOn: previous });
	}
}

async function updateConnectionWriteAllowlist(id: string, next: string[]) {
	const previous = connections.find((conn) => conn.id === id)?.writeAllowlist;
	if (!previous) return;
	patchConnectionLocal(id, { writeAllowlist: next });
	try {
		await updateConnection(id, { writeAllowlist: next });
	} catch {
		patchConnectionLocal(id, { writeAllowlist: previous });
	}
}

async function disconnectConnectionById(id: string) {
	try {
		await disconnectConnection(id);
		connections = connections.filter((conn) => conn.id !== id);
	} catch {
		// Non-fatal: card stays put so the user can retry.
	}
}

function startConnect(provider: ConnectionProvider) {
	// 7.3 reads this intent to open the connect wizard modal.
	connectWizardProvider = provider;
}

function reconnectConnection(connectionId: string) {
	// 7.3 reads this intent to open the reconnect wizard modal.
	reconnectConnectionId = connectionId;
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
		showMessage("adminMessage", "Configuration saved.");
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
				avatarColors={AVATAR_COLORS}
				avatarCount={AVATAR_COUNT}
				selectedAvatar={selectedAvatar}
				bind:showAvatarPicker
				{removingPhoto}
				onOpenPictureEditor={() => (showPictureEditor = true)}
				onRemovePhoto={removePhoto}
				onSelectAvatar={selectAvatar}
				bind:name
				bind:email
				{profileSaving}
				{profileMessage}
				{profileError}
				onSaveProfile={saveProfile}
				bind:currentPassword
				bind:newPassword
				bind:confirmPassword
				bind:showCurrentPw
				bind:showNewPw
				bind:showConfirmPw
				{passwordSaving}
				{passwordMessage}
				{passwordError}
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
				onToggleCapability={toggleConnectionCapability}
				onToggleAllowWrites={toggleConnectionAllowWrites}
				onToggleDefaultOn={toggleConnectionDefaultOn}
				onUpdateWriteAllowlist={updateConnectionWriteAllowlist}
				onDisconnect={disconnectConnectionById}
				onStartConnect={startConnect}
				onReconnect={reconnectConnection}
			/>
			<!-- 7.3: connect wizard modal reads connectWizardProvider /
			     reconnectConnectionId (state above) and renders the add/
			     reconnect forms. Not built here. -->
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

	:global(.avatar-swatch) {
		border: 2px solid transparent;
		cursor: pointer;
		transition: all var(--duration-standard);
		display: flex;
		align-items: center;
		justify-content: center;
	}

	:global(.avatar-swatch:hover) {
		transform: scale(1.08);
	}

	:global(.avatar-selected) {
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--surface-page), 0 0 0 4px var(--accent);
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
