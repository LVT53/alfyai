<script lang="ts">
import { onMount } from "svelte";
import {
	ChevronLeft,
	ChevronRight,
	Download,
	FileText,
	Palette,
	Trash2,
	Upload,
} from "@lucide/svelte";
import AvatarCircle from "$lib/components/ui/AvatarCircle.svelte";
import ModelIcon from "$lib/components/ui/ModelIcon.svelte";
import { t } from "$lib/i18n";
import {
	fetchUserSkills,
	fetchUserSkillVariants,
	type UserSkill,
	type UserSkillVariant,
} from "$lib/client/api/skills";
import {
	getPersonalityProfileDisplayDescription,
	getPersonalityProfileDisplayName,
} from "$lib/utils/personality-profile-labels";
import PasswordField from "./PasswordField.svelte";
import UserSkillsSettingsSurface from "./UserSkillsSettingsSurface.svelte";
import SettingsDataImport from "./SettingsDataImport.svelte";
import SettingsPersonalAnalytics from "./SettingsPersonalAnalytics.svelte";
import type { AnalyticsResponse } from "$lib/client/api/settings";
import type { ModelId, UserModelPreference } from "$lib/types";
import type { Project } from "$lib/types";

type AvailableModel = {
	id: ModelId;
	displayName: string;
	iconUrl?: string | null;
};
type Theme = "system" | "light" | "dark";
type TitleLanguage = "auto" | "en" | "hu";
type UiLanguage = "en" | "hu";

let {
	userId,
	userDisplayName,
	userEmail,
	profilePicture = null,
	cacheBuster = 0,
	avatarColors,
	avatarCount,
	selectedAvatar,
	showAvatarPicker = $bindable(false),
	removingPhoto = false,
	onOpenPictureEditor,
	onRemovePhoto,
	onSelectAvatar,
	name = $bindable(""),
	email = $bindable(""),
	profileSaving = false,
	profileMessage = "",
	profileError = "",
	onSaveProfile,
	currentPassword = $bindable(""),
	newPassword = $bindable(""),
	confirmPassword = $bindable(""),
	showCurrentPw = $bindable(false),
	showNewPw = $bindable(false),
	showConfirmPw = $bindable(false),
	passwordSaving = false,
	passwordMessage = "",
	passwordError = "",
	onSavePassword,
	availableModels,
	selectedModel,
	effectiveModel,
	systemDefaultModel = effectiveModel,
	selectedTheme,
	selectedTitleLanguage,
	selectedUiLanguage,
	onChangeModel,
	onChangeTheme,
	onChangeTitleLanguage,
	onChangeUiLanguage,
	memoryEnabled = true,
	memorySaving = false,
	onChangeMemoryEnabled = undefined,
	personalityProfiles = [],
	selectedPersonalityId = null,
	onChangePersonality = undefined,
	onOpenDownloadArchive,
	onOpenClearMemory,
	onOpenClearWorkspace,
	onOpenDeleteModal,
	archiveLoading = false,
	clearMemoryLoading = false,
	clearWorkspaceLoading = false,
	privacyControlsError = "",
	privacyControlsMessage = "",
	skillsEnabled = false,
	projects = [],
	// ADR-0043 slice 18c: 5th "Your Activity" section (personal analytics).
	// PERSONAL ONLY — the page passes only the personal analytics data path.
	personalAnalyticsData = null,
	personalAnalyticsLoading = false,
	personalAnalyticsError = "",
	modelNames = {},
	modelIcons = {},
	onRetryPersonalAnalytics = undefined,
	selectedPersonalMonth = null,
	onPersonalMonthChange = undefined,
	onPersonalTimelineChange = undefined,
}: {
	userId: string;
	userDisplayName: string;
	userEmail: string;
	profilePicture?: string | null;
	cacheBuster?: number;
	avatarColors: string[];
	avatarCount: number;
	selectedAvatar: number | null;
	showAvatarPicker: boolean;
	removingPhoto?: boolean;
	onOpenPictureEditor: () => void;
	onRemovePhoto: () => void | Promise<void>;
	onSelectAvatar: (avatarId: number) => void | Promise<void>;
	name: string;
	email: string;
	profileSaving?: boolean;
	profileMessage?: string;
	profileError?: string;
	onSaveProfile: () => void | Promise<void>;
	currentPassword: string;
	newPassword: string;
	confirmPassword: string;
	showCurrentPw: boolean;
	showNewPw: boolean;
	showConfirmPw: boolean;
	passwordSaving?: boolean;
	passwordMessage?: string;
	passwordError?: string;
	onSavePassword: () => void | Promise<void>;
	availableModels: AvailableModel[];
	selectedModel: UserModelPreference;
	effectiveModel: ModelId;
	systemDefaultModel?: ModelId;
	selectedTheme: Theme;
	selectedTitleLanguage: TitleLanguage;
	selectedUiLanguage: UiLanguage;
	onChangeModel: (model: UserModelPreference) => void | Promise<void>;
	onChangeTheme: (theme: Theme) => void | Promise<void>;
	onChangeTitleLanguage: (lang: TitleLanguage) => void | Promise<void>;
	onChangeUiLanguage: (lang: UiLanguage) => void | Promise<void>;
	memoryEnabled?: boolean;
	memorySaving?: boolean;
	onChangeMemoryEnabled?:
		| ((enabled: boolean) => void | Promise<void>)
		| undefined;
	personalityProfiles?: Array<{
		id: string;
		name: string;
		description: string;
	}>;
	selectedPersonalityId?: string | null;
	onChangePersonality?: ((id: string | null) => void) | undefined;
	onOpenDownloadArchive: () => void;
	onOpenClearMemory: () => void;
	onOpenClearWorkspace: () => void;
	onOpenDeleteModal: () => void;
	archiveLoading?: boolean;
	clearMemoryLoading?: boolean;
	clearWorkspaceLoading?: boolean;
	privacyControlsError?: string;
	privacyControlsMessage?: string;
	skillsEnabled?: boolean;
	projects?: Project[];
	personalAnalyticsData?: AnalyticsResponse | null;
	personalAnalyticsLoading?: boolean;
	personalAnalyticsError?: string;
	modelNames?: Record<string, string>;
	modelIcons?: Record<string, string | null | undefined>;
	onRetryPersonalAnalytics?: (() => void | Promise<void>) | undefined;
	selectedPersonalMonth?: string | null;
	onPersonalMonthChange?: ((month: string | null) => void) | undefined;
	onPersonalTimelineChange?: ((granularity: string) => void) | undefined;
} = $props();

const systemDefaultModelDisplayName = $derived(
	availableModels.find((model) => model.id === systemDefaultModel)
		?.displayName ?? systemDefaultModel,
);
const explicitModelOptions = $derived(
	availableModels.filter((model) => model.id !== systemDefaultModel),
);

// --- ADR-0043 slice 18b: Skills summary card + full-screen manager ---
// View state is client-only ($state); NOT a route/URL change. The manager
// overlays the Profile content when open.
let skillsManagerOpen = $state(false);

// Summary counts are lifted up here so the summary card can show
// "N active · M disabled" without rendering the full editor inline. The
// UserSkillsSettingsSurface itself is re-homed (rendered unchanged) inside
// the manager — its data loading is NOT duplicated here beyond the summary.
let skillsSummary = $state<{ active: number; disabled: number }>({
	active: 0,
	disabled: 0,
});

async function loadSkillsSummary() {
	if (!skillsEnabled) return;
	try {
		const [skills, variants] = await Promise.all([
			fetchUserSkills(),
			fetchUserSkillVariants(),
		]);
		const all: Array<UserSkill | UserSkillVariant> = [...skills, ...variants];
		skillsSummary = {
			active: all.filter((skill) => skill.enabled).length,
			disabled: all.filter((skill) => !skill.enabled).length,
		};
	} catch {
		// Non-fatal: keep the zeroed summary. The manager surfaces real errors.
	}
}

onMount(() => {
	void loadSkillsSummary();
});
</script>

<!-- ============================================================= -->
<!-- ADR-0043 slice 18a: Profile regrouped into 4 labeled sections. -->
<!-- ALL existing fields preserved; text CTAs → btn-icon-bare Lucide -->
<!-- icon buttons; "Default Style" → "Conversation style"; jargon cleared. -->
<!-- ADR-0043 slice 18b: Skills promoted to a summary card that opens a -->
<!-- dedicated full-screen manager (UserSkillsSettingsSurface re-homed). -->
<!-- 18c adds the 5th "Your Activity" section. Do NOT do that here. -->
<!-- ============================================================= -->

<!-- ================= GROUP 1: ACCOUNT ================= -->
<p class="settings-group-label">{$t('settings_sectionAccount')}</p>
<section class="settings-card mb-4">
	<h2 class="settings-section-title">{$t('settings_avatar')}</h2>
	<div class="flex items-center gap-4">
		<AvatarCircle
			{userId}
			name={userDisplayName}
			avatarId={selectedAvatar}
			{profilePicture}
			{cacheBuster}
			size={48}
		/>
		<div class="flex flex-wrap items-center gap-2">
			<button
				type="button"
				class="btn-icon-bare"
				aria-label={$t('settings_uploadPhotoA11y')}
				title={$t('settings_uploadPhoto')}
				onclick={onOpenPictureEditor}
			>
				<Upload size={16} strokeWidth={2} aria-hidden="true" />
			</button>
			<button
				type="button"
				class="btn-icon-bare"
				aria-label={$t('settings_changeColorA11y')}
				title={$t('settings_changeColor')}
				onclick={() => (showAvatarPicker = !showAvatarPicker)}
			>
				<Palette size={16} strokeWidth={2} aria-hidden="true" />
			</button>
			{#if profilePicture}
				<button
					type="button"
					class="btn-icon-bare"
					style="color: var(--danger);"
					aria-label={$t('settings_removePhotoA11y')}
					title={removingPhoto ? $t('settings_removing') : $t('settings_removePhoto')}
					onclick={onRemovePhoto}
					disabled={removingPhoto}
				>
					<Trash2 size={16} strokeWidth={2} aria-hidden="true" />
				</button>
			{/if}
		</div>
	</div>
</section>

<section class="settings-card mb-4">
	<h2 class="settings-section-title">{$t('settings_profileInformation')}</h2>
	<div class="flex flex-col gap-3">
		<div>
			<label class="settings-label" for="name">{$t('settings_displayName')}</label>
			<input id="name" type="text" class="settings-input" bind:value={name} placeholder={$t('settings_yourName')} />
		</div>
		<div>
			<label class="settings-label" for="email">{$t('settings_emailAddress')}</label>
			<input
				id="email"
				type="email"
				class="settings-input"
				bind:value={email}
				placeholder={$t('settings_emailExample')}
			/>
		</div>
		{#if profileMessage}
			<p class="text-sm text-success">{profileMessage}</p>
		{/if}
		{#if profileError}
			<p class="text-sm text-danger">{profileError}</p>
		{/if}
		<button class="btn-primary self-start" onclick={onSaveProfile} disabled={profileSaving}>
			{profileSaving ? $t('settings_saving') : $t('settings_save')}
		</button>
	</div>
</section>

<section class="settings-card mb-4">
	<h2 class="settings-section-title">{$t('settings_changePassword')}</h2>
	<div class="flex flex-col gap-3">
		<PasswordField
			id="current-pw"
			label={$t('settings_currentPassword')}
			bind:value={currentPassword}
			bind:shown={showCurrentPw}
			autocomplete="current-password"
		/>
		<PasswordField
			id="new-pw"
			label={$t('settings_newPassword')}
			bind:value={newPassword}
			bind:shown={showNewPw}
			autocomplete="new-password"
		/>
		<PasswordField
			id="confirm-pw"
			label={$t('settings_confirmNewPassword')}
			bind:value={confirmPassword}
			bind:shown={showConfirmPw}
			autocomplete="new-password"
		/>
		{#if passwordMessage}
			<p class="text-sm text-success">{passwordMessage}</p>
		{/if}
		{#if passwordError}
			<p class="text-sm text-danger">{passwordError}</p>
		{/if}
		<button class="btn-primary self-start" onclick={onSavePassword} disabled={passwordSaving}>
			{passwordSaving ? $t('settings_saving') : $t('settings_changePassword')}
		</button>
	</div>
</section>

<!-- Import (ChatGPT) stays grouped under Account; 18a leaves its modal intact. -->
<SettingsDataImport {projects} />

<!-- ================= GROUP 2: PREFERENCES ================= -->
<p class="settings-group-label">{$t('settings_sectionPreferences')}</p>
<section class="settings-card mb-4">
	<div class="flex flex-col gap-5">
		<div>
			<p class="settings-label">{$t('settings_defaultModel')}</p>
			<div class="model-preference-grid" data-testid="settings-default-model-grid">
				<button
					class="pref-pill model-preference-pill model-preference-pill-system"
					class:pref-pill-active={selectedModel === null}
					title={$t('settings.systemDefaultModelResolved', { model: systemDefaultModelDisplayName })}
					aria-label={$t('settings.systemDefaultModelResolved', { model: systemDefaultModelDisplayName })}
					onclick={() => onChangeModel(null)}
				>
					<span class="model-preference-pill-main">
						<ModelIcon iconUrl={availableModels.find((model) => model.id === systemDefaultModel)?.iconUrl ?? null} displayName={systemDefaultModelDisplayName} size={20} />
						<span class="model-preference-pill-label">{$t('settings.systemDefaultModel')}</span>
					</span>
					<span class="model-preference-pill-subtitle">{systemDefaultModelDisplayName}</span>
				</button>
				{#each explicitModelOptions as model}
					<button
						class="pref-pill model-preference-pill"
						class:pref-pill-active={selectedModel === model.id}
						title={model.displayName}
						onclick={() => onChangeModel(model.id)}
					>
						<span class="model-preference-pill-main">
							<ModelIcon iconUrl={model.iconUrl ?? null} displayName={model.displayName} size={20} />
							<span class="model-preference-pill-label">{model.displayName}</span>
						</span>
					</button>
				{/each}
			</div>
		</div>

		{#if personalityProfiles.length > 0}
			<div>
				<!-- ADR-0043 18a: "Default Style" → "Conversation style" + clarifying note. -->
				<p class="settings-label">{$t('settings_conversationStyle')}</p>
				<p class="settings-help-text">{$t('settings_conversationStyleNote')}</p>
				<div class="flex gap-2">
					<button
						class="pref-pill"
						class:pref-pill-active={!selectedPersonalityId}
						onclick={() => onChangePersonality?.(null)}
					>{$t('composerTools.defaultStyle')}</button>
					{#each personalityProfiles as profile}
						<button
							class="pref-pill"
							class:pref-pill-active={selectedPersonalityId === profile.id}
							title={getPersonalityProfileDisplayDescription(profile, $t)}
							onclick={() => onChangePersonality?.(profile.id)}
						>{getPersonalityProfileDisplayName(profile, $t)}</button>
					{/each}
				</div>
			</div>
		{/if}

		<div>
			<!-- ADR-0043 18a: "Theme" → "Appearance" (jargon clearing per mockup). -->
			<p class="settings-label">{$t('settings_appearance')}</p>
			<div class="flex gap-2">
				{#each [
					{ value: 'system' as const, label: $t('settings_system') },
					{ value: 'light' as const, label: $t('settings_light') },
					{ value: 'dark' as const, label: $t('settings_dark') },
				] as theme}
					<button
						class="pref-pill"
						class:pref-pill-active={selectedTheme === theme.value}
						onclick={() => onChangeTheme(theme.value)}
					>
						{theme.label}
					</button>
				{/each}
			</div>
		</div>

		<div>
			<!-- ADR-0043 18a: "UI Language" → "Interface language" + clarifying note. -->
			<p class="settings-label">{$t('settings_interfaceLanguage')}</p>
			<p class="settings-help-text">{$t('settings_interfaceLanguageNote')}</p>
			<div class="flex gap-2">
				{#each [
					{ value: 'en' as const, label: $t('english') },
					{ value: 'hu' as const, label: $t('hungarian') },
				] as lang}
					<button
						class="pref-pill"
						class:pref-pill-active={selectedUiLanguage === lang.value}
						onclick={() => onChangeUiLanguage(lang.value)}
					>
						{lang.label}
					</button>
				{/each}
			</div>
		</div>

		<div>
			<p class="settings-label">{$t('settings_titleLanguage')}</p>
			<div class="flex gap-2">
				{#each [
					{ value: 'auto' as const, label: $t('settings_autoDetect') },
					{ value: 'en' as const, label: $t('settings_english') },
					{ value: 'hu' as const, label: $t('settings_hungarian') },
				] as lang}
					<button
						class="pref-pill"
						class:pref-pill-active={selectedTitleLanguage === lang.value}
						onclick={() => onChangeTitleLanguage(lang.value)}
					>
						{lang.label}
					</button>
				{/each}
			</div>
		</div>
	</div>
</section>

<!-- Memory master toggle: pauses/resumes all cross-chat learning. -->
<section id="settings-memory-card" class="settings-card mb-4">
	<div class="memory-toggle-row">
		<div class="memory-toggle-text">
			<p class="settings-label memory-toggle-label">{$t('settings_memory')}</p>
			<p class="settings-help-text memory-toggle-help">{$t('settings_memoryHelp')}</p>
		</div>
		<button
			type="button"
			role="switch"
			aria-checked={memoryEnabled}
			aria-label={$t('settings_memory')}
			class="toggle-btn"
			class:toggle-on={memoryEnabled}
			disabled={memorySaving}
			onclick={() => onChangeMemoryEnabled?.(!memoryEnabled)}
		>
			<span class="toggle-thumb"></span>
		</button>
	</div>
</section>

<!-- ================= GROUP 3: ASSISTANT ================= -->
<!-- ADR-0043 slice 18b: the inline Skills editor is promoted to a summary card -->
<!-- that opens a dedicated full-screen manager. The UserSkillsSettingsSurface -->
<!-- is re-homed (rendered unchanged) inside the manager below — not duplicated. -->
<p class="settings-group-label">{$t('settings_sectionAssistant')}</p>
<section class="settings-card mb-4">
	{#if skillsEnabled}
		<!-- Summary card: label + one-line status + ChevronRight open affordance. -->
		<button
			type="button"
			class="skills-summary-card"
			data-testid="skills-summary-card"
			aria-label={$t('settings_skillsManagerSummaryLabel')}
			title={$t('settings_skillsManagerOpenA11y')}
			onclick={() => (skillsManagerOpen = true)}
		>
			<span class="skills-summary-card-text">
				<span class="skills-summary-card-label">{$t('settings_skillsManagerSummaryLabel')}</span>
				<span class="skills-summary-card-status">
					{$t('settings_skillsManagerStatus', {
						active: skillsSummary.active,
						disabled: skillsSummary.disabled,
					})}
				</span>
			</span>
			<ChevronRight size={16} strokeWidth={2} aria-hidden="true" />
		</button>
	{:else}
		<!-- Skills disabled by workspace admin: no manager to open into. -->
		<p class="text-sm text-text-secondary">{$t('skills.disabled')}</p>
	{/if}
</section>

<!-- ADR-0043 slice 18b: full-screen Skills manager. Hosts the RE-HOMED -->
<!-- UserSkillsSettingsSurface (same component, not copied). Overlays the -->
<!-- Profile content via client-only $state; back chevron returns to Profile. -->
{#if skillsManagerOpen}
	<div class="skills-manager" data-testid="skills-manager">
		<div class="skills-manager-header">
			<button
				type="button"
				class="btn-icon-bare"
				aria-label={$t('settings_skillsManagerBack')}
				onclick={() => (skillsManagerOpen = false)}
			>
				<ChevronLeft size={20} strokeWidth={2} aria-hidden="true" />
			</button>
			<h1 class="skills-manager-title">{$t('settings_skillsManagerTitle')}</h1>
		</div>
		<!-- Re-homed: the SAME editor component, rendered here, not inline above. -->
		<UserSkillsSettingsSurface {skillsEnabled} />
	</div>
{/if}

<!-- ================= GROUP 4: DATA & PRIVACY ================= -->
<p class="settings-group-label">{$t('settings_sectionDataPrivacy')}</p>
<section class="settings-card mb-4">
	<p class="mb-4 text-sm text-text-secondary">
		{$t('settings_privacyControlsDescription')}
	</p>
	{#if privacyControlsError}
		<p class="mb-3 text-sm text-danger">{privacyControlsError}</p>
	{/if}
	{#if privacyControlsMessage}
		<p class="mb-3 text-sm text-success">{privacyControlsMessage}</p>
	{/if}
	<ul class="privacy-action-list">
		<!-- Redesign R6 (ADR 0044 Decision 5) — compact entry row that links
		     straight to the public /privacy route (src/routes/privacy/+page.svelte),
		     the single content source. No in-app modal (an early build added
		     one; the product owner asked to remove it — see ADR 0044). -->
		<li class="privacy-action-row">
			<span class="privacy-action-label">{$t('settings_privacyPolicy')}</span>
			<a
				href="/privacy"
				class="btn-icon-bare privacy-action-btn"
				aria-label={$t('settings_privacyPolicy')}
				title={$t('settings_privacyPolicy')}
			>
				<FileText size={16} strokeWidth={2} aria-hidden="true" />
			</a>
		</li>
		<li class="privacy-action-row">
			<span class="privacy-action-label">{$t('settings_downloadMyData')}</span>
			<button
				type="button"
				class="btn-icon-bare privacy-action-btn"
				aria-label={$t('settings_downloadMyData')}
				title={$t('settings_downloadMyData')}
				onclick={onOpenDownloadArchive}
				disabled={archiveLoading}
			>
				<Download size={16} strokeWidth={2} aria-hidden="true" />
			</button>
		</li>
		<li class="privacy-action-row">
			<span class="privacy-action-label">{$t('settings_clearMemoryAndKnowledge')}</span>
			<button
				type="button"
				class="btn-icon-bare privacy-action-btn"
				style="color: var(--danger);"
				aria-label={$t('settings_clearMemoryAndKnowledge')}
				title={$t('settings_clearMemoryAndKnowledge')}
				onclick={onOpenClearMemory}
				disabled={clearMemoryLoading}
			>
				<Trash2 size={16} strokeWidth={2} aria-hidden="true" />
			</button>
		</li>
		<li class="privacy-action-row">
			<span class="privacy-action-label">{$t('settings_clearWorkspaceData')}</span>
			<button
				type="button"
				class="btn-icon-bare privacy-action-btn"
				style="color: var(--danger);"
				aria-label={$t('settings_clearWorkspaceData')}
				title={$t('settings_clearWorkspaceData')}
				onclick={onOpenClearWorkspace}
				disabled={clearWorkspaceLoading}
			>
				<Trash2 size={16} strokeWidth={2} aria-hidden="true" />
			</button>
		</li>
		<li class="privacy-action-row">
			<span class="privacy-action-label privacy-action-label-danger">{$t('settings_deleteAccountPrivacy')}</span>
			<!-- Account deletion is the destructive action: solid red Trash2 CTA, -->
			<!-- distinguished from the quiet btn-icon-bare buttons above. -->
			<button
				type="button"
				class="btn-danger privacy-action-btn"
				aria-label={$t('settings_deleteAccountPrivacy')}
				title={$t('settings_deleteAccountPrivacy')}
				onclick={onOpenDeleteModal}
			>
				<Trash2 size={16} strokeWidth={2} aria-hidden="true" />
			</button>
		</li>
	</ul>
</section>

<!-- ================= GROUP 5: YOUR ACTIVITY ================= -->
<!-- ADR-0043 slice 18c: personal analytics merged into Profile as the 5th -->
<!-- section. PERSONAL ONLY (the user's own usage); system analytics stays -->
<!-- admin-gated under Administration. 18a/18b sections above are untouched. -->
<!-- The group label serves as the section heading (no redundant inner h2). -->
<p class="settings-group-label">{$t('settings_sectionYourActivity')}</p>
<section class="settings-card mb-4">
	<SettingsPersonalAnalytics
		analyticsData={personalAnalyticsData}
		analyticsLoading={personalAnalyticsLoading}
		analyticsError={personalAnalyticsError}
		{modelNames}
		{modelIcons}
		onRetry={onRetryPersonalAnalytics ?? (() => {})}
		selectedMonth={selectedPersonalMonth}
		onMonthChange={onPersonalMonthChange}
		onTimelineChange={onPersonalTimelineChange}
	/>
</section>

<style>
	/* Section group label: uppercase, letter-spaced, muted, semibold (per mockup). */
	.settings-group-label {
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-muted);
		margin: var(--space-lg) 0 var(--space-sm) 0;
	}

	/* First group label sits flush at the top (no top margin). */
	.settings-group-label:first-child {
		margin-top: 0;
	}

	.settings-help-text {
		font-size: 0.75rem;
		color: var(--text-secondary);
		margin-top: -0.125rem;
		margin-bottom: 0.375rem;
	}

	/* Memory master toggle: label/help on the left, switch on the right. */
	.memory-toggle-row {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
	}

	.memory-toggle-text {
		min-width: 0;
	}

	.memory-toggle-label {
		margin-bottom: 0.25rem;
	}

	.memory-toggle-help {
		margin-bottom: 0;
	}

	.toggle-btn:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.model-preference-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 13.5rem), 1fr));
		gap: 0.75rem;
		width: 100%;
		min-width: 0;
	}

	.model-preference-pill {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		min-width: 0;
		min-height: 2.75rem;
		overflow: hidden;
		text-align: center;
	}

	.model-preference-pill-system {
		flex-direction: column;
		gap: 0.125rem;
	}

	.model-preference-pill-main {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		max-width: 100%;
		min-width: 0;
	}

	.model-preference-pill-label,
	.model-preference-pill-subtitle {
		min-width: 0;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.model-preference-pill-subtitle {
		font-size: 0.75rem;
		opacity: 0.7;
	}

	/* Data & privacy action rows (per mockup): label left, icon button right. */
	.privacy-action-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	.privacy-action-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.625rem 0;
	}

	.privacy-action-row + .privacy-action-row {
		border-top: 1px solid var(--border-default);
	}

	.privacy-action-label {
		font-size: 0.8125rem;
		color: var(--text-primary);
	}

	.privacy-action-label-danger {
		color: var(--danger);
		font-weight: 500;
	}

	/* Slightly tighter icon buttons inside the dense privacy list. */
	.privacy-action-btn {
		min-height: 2rem;
		min-width: 2rem;
	}

		@media (prefers-reduced-motion: reduce) {
			.btn-icon-bare,
			.btn-danger {
				transition: none;
			}
		}

		/* ADR-0043 slice 18b: Skills summary card + full-screen manager. */

		/* Summary card: full-width button row (label + status left, chevron right). */
		.skills-summary-card {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 0.75rem;
			width: 100%;
			padding: 0;
			border: none;
			background: none;
			cursor: pointer;
			color: inherit;
			transition: color var(--duration-standard);
		}

		.skills-summary-card:hover {
			color: var(--accent);
		}

		.skills-summary-card-text {
			display: flex;
			flex-direction: column;
			gap: 0.125rem;
			min-width: 0;
			text-align: left;
		}

		.skills-summary-card-label {
			font-size: 0.9375rem;
			font-weight: 600;
			color: var(--text-primary);
		}

		.skills-summary-card-status {
			font-size: 0.75rem;
			color: var(--text-secondary);
		}

		/* Full-screen manager: overlays/replaces the Profile content. */
		.skills-manager {
			display: flex;
			flex-direction: column;
			gap: var(--space-md);
		}

		.skills-manager-header {
			display: flex;
			align-items: center;
			gap: 0.5rem;
		}

		.skills-manager-title {
			font-size: 1.25rem;
			font-weight: 600;
			color: var(--text-primary);
			margin: 0;
		}

		@media (prefers-reduced-motion: reduce) {
			.skills-summary-card {
				transition: none;
			}
		}
	</style>
