<script lang="ts">
import { goto, invalidate } from "$app/navigation";
import ProfilePictureEditor from "$lib/components/ui/ProfilePictureEditor.svelte";
import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
import { clearConversationSessionState } from "$lib/client/conversation-session";
import {
	deleteAccount,
	deleteAvatar,
	fetchAnalytics,
	fetchHonchoHealth,
	resetAccount,
	updateAdminConfig,
	updatePassword,
	updateProfile,
	updateUserPreferences,
	type AnalyticsResponse,
} from "$lib/client/api/settings";
import { submitKnowledgeBulkAction } from "$lib/client/api/knowledge";
import { fetchPublicPersonalityProfiles } from "$lib/client/api/admin";
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
import DeleteAccountModal from "./_components/DeleteAccountModal.svelte";
import ResetAccountModal from "./_components/ResetAccountModal.svelte";
import SettingsAdministrationTab from "./_components/SettingsAdministrationTab.svelte";
import SettingsAnalyticsTab from "./_components/SettingsAnalyticsTab.svelte";
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

type Tab = "profile" | "analytics" | "administration";

const initialUserSettings = getData().userSettings;
const initialPreferences = initialUserSettings.preferences;
const initialCurrentConfigValues = (getData() as SettingsPageData)
	.currentConfigValues;
const isAdmin = initialUserSettings.role === "admin";
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
let selectedAvatar = $state(initialPreferences.avatarId);
let selectedPersonalityId = $state<string | null>(
	initialPreferences.preferredPersonalityId ?? null,
);
let personalityProfiles = $state<
	Array<{ id: string; name: string; description: string }>
>([]);

let showDeleteModal = $state(false);
let deletePassword = $state("");
let deleteError = $state("");
let deleteLoading = $state(false);
let showDeletePw = $state(false);
let showResetModal = $state(false);
let resetPassword = $state("");
let resetError = $state("");
let resetLoading = $state(false);
let showResetPw = $state(false);

let forgetEverythingLoading = $state(false);
let forgetEverythingError = $state("");
let showForgetEverythingConfirm = $state(false);

let adminConfig = $state<Record<string, string>>(
	initialCurrentConfigValues ? { ...initialCurrentConfigValues } : {},
);
let adminSaving = $state(false);
let adminMessage = $state("");
let adminError = $state("");

let honchoHealth = $state<{
	enabled: boolean;
	connected: boolean;
	workspace: string | null;
} | null>(null);
let honchoLoading = $state(false);

async function checkHonchoHealth() {
	honchoLoading = true;
	try {
		honchoHealth = await fetchHonchoHealth();
	} catch {
		honchoHealth = null;
	} finally {
		honchoLoading = false;
	}
}

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
let showAvatarPicker = $state(false);
let showPictureEditor = $state(false);
let removingPhoto = $state(false);

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function loadAnalytics(
	month?: string | null,
	timeline: string | null = "weekly",
) {
	analyticsLoading = true;
	analyticsError = "";
	try {
		analyticsData = await fetchAnalytics(
			import.meta.env.DEV,
			month ?? undefined,
			timeline ?? undefined,
		);
	} catch (error: unknown) {
		analyticsError = errorMessage(error);
	} finally {
		analyticsLoading = false;
	}
}

async function handleMonthChange(month: string | null) {
	analyticsMonth = month;
	await loadAnalytics(month, "weekly");
}

async function handleTimelineChange(granularity: string) {
	await loadAnalytics(analyticsMonth, granularity);
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

function closeDeleteModal() {
	showDeleteModal = false;
	deletePassword = "";
	deleteError = "";
	showDeletePw = false;
}

function closeResetModal() {
	showResetModal = false;
	resetPassword = "";
	resetError = "";
	showResetPw = false;
}

async function confirmDeleteAccount() {
	deleteError = "";
	deleteLoading = true;
	try {
		await deleteAccount(deletePassword);
		goto("/login");
	} catch (error: unknown) {
		deleteError = errorMessage(error);
	} finally {
		deleteLoading = false;
	}
}

async function confirmResetAccount() {
	resetError = "";
	resetLoading = true;
	try {
		await resetAccount(resetPassword);
		reconcileConversationSnapshot([], { resetLocalState: true });
		projects.set([]);
		currentConversationId.set(null);
		clearConversationSessionState();
		analyticsData = null;
		analyticsError = "";
		closeResetModal();
		await goto("/login");
	} catch (error: unknown) {
		resetError = errorMessage(error);
	} finally {
		resetLoading = false;
	}
}

function requestForgetEverything() {
	showForgetEverythingConfirm = true;
}

function closeForgetEverythingConfirm() {
	showForgetEverythingConfirm = false;
}

async function runForgetEverything() {
	forgetEverythingError = "";
	showForgetEverythingConfirm = false;

	forgetEverythingLoading = true;
	try {
		const result = await submitKnowledgeBulkAction("forget_everything");
		if (result.success === false) {
			throw new Error(
				result.error ?? result.message ?? "Failed to forget everything.",
			);
		}
		forgetEverythingError = "";
	} catch (error: unknown) {
		forgetEverythingError = errorMessage(error);
	} finally {
		forgetEverythingLoading = false;
	}
}

async function saveAdminConfig() {
	adminSaving = true;
	adminMessage = "";
	adminError = "";
	try {
		await updateAdminConfig(adminConfig);
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
	if (tab === "analytics" && !analyticsData && !analyticsLoading) {
		await loadAnalytics();
	}
}

$effect(() => {
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
});
</script>

<div class="flex h-full min-h-0 w-full flex-1 flex-col overflow-y-auto">
	<div class="settings-shell mx-auto w-full px-4 py-8" class:settings-shell-admin={activeTab === 'administration' && isAdmin}>
		<h1 class="mb-6 text-2xl font-semibold text-text-primary">{$t('settings')}</h1>

		<div class="mb-6 flex gap-1 rounded-lg border border-border bg-surface-overlay p-1">
			<button
				class="tab-btn flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors duration-150"
				class:tab-active={activeTab === 'profile'}
				onclick={() => handleTabChange('profile')}
			>
				{$t('settingsProfile')}
			</button>
			<button
				class="tab-btn flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors duration-150"
				class:tab-active={activeTab === 'analytics'}
				onclick={() => handleTabChange('analytics')}
			>
				{$t('settingsAnalytics')}
			</button>
			{#if isAdmin}
				<button
					class="tab-btn flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors duration-150"
					class:tab-active={activeTab === 'administration'}
					onclick={() => handleTabChange('administration')}
				>
					{$t('settingsAdministration')}
				</button>
			{/if}
		</div>

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
				{personalityProfiles}
				{selectedPersonalityId}
				onChangePersonality={changePersonality}
				onOpenResetModal={() => (showResetModal = true)}
				onOpenDeleteModal={() => (showDeleteModal = true)}
				forgetEverythingLoading={forgetEverythingLoading}
				forgetEverythingError={forgetEverythingError}
				onForgetEverything={requestForgetEverything}
				skillsEnabled={(data as SettingsPageData).composerCommandRegistryEnabled ?? false}
				projects={$projects}
			/>
		{/if}

		{#if activeTab === 'analytics'}
			<SettingsAnalyticsTab
				{analyticsData}
				{analyticsLoading}
				{analyticsError}
				{isAdmin}
				{modelNames}
				{modelIcons}
				onRetry={loadAnalytics}
				selectedMonth={analyticsMonth}
				onMonthChange={handleMonthChange}
				onTimelineChange={handleTimelineChange}
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
				{honchoHealth}
				{honchoLoading}
				onCheckHonchoHealth={checkHonchoHealth}
				onSaveAdminConfig={saveAdminConfig}
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

{#if showDeleteModal}
	<DeleteAccountModal
		bind:deletePassword
		{deleteError}
		{deleteLoading}
		bind:showDeletePw
		onConfirm={confirmDeleteAccount}
		onCancel={closeDeleteModal}
	/>
{/if}

{#if showResetModal}
	<ResetAccountModal
		bind:resetPassword
		{resetError}
		{resetLoading}
		bind:showResetPw
		onConfirm={confirmResetAccount}
		onCancel={closeResetModal}
	/>
{/if}

{#if showForgetEverythingConfirm}
	<ConfirmDialog
		title={$t('settings_resetMemory')}
		message={$t('settings_resetMemoryMessage')}
		confirmText={forgetEverythingLoading ? $t('settings_resetting') : $t('settings_resetMemory')}
		confirmVariant="danger"
		onCancel={closeForgetEverythingConfirm}
		onConfirm={() => {
			if (!forgetEverythingLoading) {
				void runForgetEverything();
			}
		}}
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

	.tab-btn {
		color: var(--text-secondary);
		background: transparent;
		border: none;
		cursor: pointer;
	}

	.tab-btn:hover {
		color: var(--text-primary);
		background: var(--surface-elevated);
	}

	.tab-active {
		color: var(--text-primary) !important;
		background: var(--surface-page) !important;
		font-weight: 600;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
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
