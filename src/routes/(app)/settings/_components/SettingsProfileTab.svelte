<script lang="ts">
// ============================================================================
// The Profile tab, streamlined to one screen (everyday-redesign, board Main +
// ProfileMobile).
//
// What changed about the SHAPE of this screen:
//
// 1. ONE IDENTITY CARD, ONE SAVE. Avatar, display name, email and the
//    password change were three cards with two Save buttons and no shared
//    state. They are one card with one Save, a Discard beside it and a
//    "Saved hh:mm" line; the password boxes are explicitly optional, so
//    saving a name no longer looks like a half-filled form. The rules live
//    in account-form.ts so they can be read without a DOM.
// 2. TWO COLUMNS INSTEAD OF FIVE SUB-TABS. The five anchor pills were a
//    scroll nav over a single 672px column. At the shared 1440px width the
//    page fits one screen, so on the desktop they are gone and everything
//    they pointed at is still here. On the phone, where the page really is
//    one long column, four of them survive as a jump-list — a shortcut,
//    never a filter.
// 3. THE THREE IRREVERSIBLE ACTIONS GET THEIR OWN CARD, at the bottom,
//    instead of sharing a flat list with Privacy policy and Download my
//    data where only the colour of a 16px icon told them apart.
//
// Posture is unchanged: a dumb prop component. Every mutation goes out
// through a callback and +page.svelte owns the fetches. What it owns here is
// view state — which full-view overlay is open — because that is not data.
// ============================================================================
import { onMount } from "svelte";
import {
	AlertTriangle,
	BookOpen,
	Check,
	ChevronLeft,
	ChevronRight,
	ExternalLink,
	Trash2,
	Upload,
} from "@lucide/svelte";
import AvatarCircle from "$lib/components/ui/AvatarCircle.svelte";
import Toggle from "$lib/components/ui/Toggle.svelte";
import { t } from "$lib/i18n";
import { prefersReducedMotion } from "$lib/utils/motion";
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
import { formatCompactCount } from "./account-form";
import PasswordField from "./PasswordField.svelte";
import UserSkillsSettingsSurface from "./UserSkillsSettingsSurface.svelte";
import SettingsDataImport from "./SettingsDataImport.svelte";
import SettingsPersonalAnalytics from "./SettingsPersonalAnalytics.svelte";
import type { AnalyticsResponse } from "$lib/client/api/settings";
import type { ModelId, UserModelPreference } from "$lib/model-types";
import type { Project } from "$lib/server/services/projects";

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
	removingPhoto = false,
	onOpenPictureEditor,
	onRemovePhoto,
	name = $bindable(""),
	email = $bindable(""),
	currentPassword = $bindable(""),
	newPassword = $bindable(""),
	confirmPassword = $bindable(""),
	showCurrentPw = $bindable(false),
	showNewPw = $bindable(false),
	showConfirmPw = $bindable(false),
	// One Save for the whole identity card. `accountDirty` is computed by the
	// page from account-form.ts so the button, the Discard and the "Saved"
	// line all read the same answer.
	accountSaving = false,
	accountDirty = false,
	savedAtLabel = "",
	onSaveAccount,
	onDiscardAccount,
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
	// ADR-0043 slice 18c: personal analytics. PERSONAL ONLY — the page passes
	// only the personal analytics data path. The tab now shows a summary card
	// and opens the full view on demand rather than printing it inline.
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
	removingPhoto?: boolean;
	onOpenPictureEditor: () => void;
	onRemovePhoto: () => void | Promise<void>;
	name: string;
	email: string;
	currentPassword: string;
	newPassword: string;
	confirmPassword: string;
	showCurrentPw: boolean;
	showNewPw: boolean;
	showConfirmPw: boolean;
	accountSaving?: boolean;
	accountDirty?: boolean;
	savedAtLabel?: string;
	onSaveAccount: () => void | Promise<void>;
	onDiscardAccount: () => void;
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

// ── Full-view overlays ───────────────────────────────────────────────
// Client-only view state; NOT a route change. Each one replaces the Profile
// content and returns via a back chevron.
let skillsManagerOpen = $state(false);
let activityViewOpen = $state(false);

// Summary counts are lifted up here so the Skills row can read "N active ·
// M disabled" without rendering the full editor. The
// UserSkillsSettingsSurface is re-homed (rendered unchanged) inside the
// manager — its data loading is NOT duplicated beyond the summary.
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

// ── Your Activity summary ────────────────────────────────────────────
// Read straight off the analytics payload the page already loads; the full
// view below renders the same data through the unchanged analytics surface.
const personal = $derived(personalAnalyticsData?.personal ?? null);
const favoriteModelName = $derived(
	personal?.favoriteModel
		? (modelNames[personal.favoriteModel] ?? personal.favoriteModel)
		: null,
);

// ── The phone jump-list ──────────────────────────────────────────────
// One chevron chip per card below, in card order. It scrolls the page to
// that card and does nothing else: nothing is hidden behind it, so ignoring
// it costs a swipe, not a screen.
const jumpTargets = [
	{ id: "settings-section-account", labelKey: "settings_sectionAccount" },
	{
		id: "settings-section-preferences",
		labelKey: "settings_sectionPreferences",
	},
	{ id: "settings-section-assistant", labelKey: "settings_sectionAssistant" },
	{
		id: "settings-section-data-privacy",
		labelKey: "settings_sectionDataPrivacy",
	},
] as const;

function scrollToSection(event: MouseEvent, id: string) {
	const target = document.getElementById(id);
	if (!target) return;
	event.preventDefault();
	target.scrollIntoView({
		behavior: prefersReducedMotion() ? "auto" : "smooth",
		block: "start",
	});
}

const themeOptions = $derived([
	{ value: "system" as const, label: $t("settings_system") },
	{ value: "light" as const, label: $t("settings_light") },
	{ value: "dark" as const, label: $t("settings_dark") },
]);
// Language names in their own language, in both dictionaries — see
// profileTab.langHungarian.
const uiLanguageOptions = $derived([
	{ value: "en" as const, label: $t("profileTab.langEnglish") },
	{ value: "hu" as const, label: $t("profileTab.langHungarian") },
]);
const titleLanguageOptions = $derived([
	{ value: "auto" as const, label: $t("settings_autoDetect") },
	{ value: "en" as const, label: $t("profileTab.langEnglish") },
	{ value: "hu" as const, label: $t("profileTab.langHungarian") },
]);

function handleModelSelect(event: Event) {
	const value = (event.currentTarget as HTMLSelectElement).value;
	void onChangeModel(value === "" ? null : (value as ModelId));
}

function handlePersonalitySelect(event: Event) {
	const value = (event.currentTarget as HTMLSelectElement).value;
	onChangePersonality?.(value === "" ? null : value);
}
</script>

{#if skillsManagerOpen}
	<!-- Full-screen Skills manager. Hosts the RE-HOMED UserSkillsSettingsSurface
	     (same component, not copied); the back chevron returns to Profile. -->
	<div class="profile-fullview" data-testid="skills-manager">
		<div class="profile-fullview-header">
			<button
				type="button"
				class="btn-icon-bare"
				aria-label={$t('settings_skillsManagerBack')}
				onclick={() => (skillsManagerOpen = false)}
			>
				<ChevronLeft size={20} strokeWidth={2} aria-hidden="true" />
			</button>
			<h2 class="profile-fullview-title">{$t('settings_skillsManagerTitle')}</h2>
		</div>
		<UserSkillsSettingsSurface {skillsEnabled} />
	</div>
{:else if activityViewOpen}
	<!-- The full Your Activity view: the same personal analytics surface the
	     tab used to print inline, opened from the summary card instead. -->
	<div class="profile-fullview" data-testid="activity-fullview">
		<div class="profile-fullview-header">
			<button
				type="button"
				class="btn-icon-bare"
				aria-label={$t('profileTab.activityBack')}
				onclick={() => (activityViewOpen = false)}
			>
				<ChevronLeft size={20} strokeWidth={2} aria-hidden="true" />
			</button>
			<h2 class="profile-fullview-title">{$t('settings_sectionYourActivity')}</h2>
		</div>
		<section class="settings-card">
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
	</div>
{:else}

<p class="settings-group-label">{$t('settingsProfile')}</p>
<p class="settings-help-text mb-3">{$t('profileTab.lead')}</p>

<!-- Phone only: a scrolling jump-list, one chip per card below. -->
<nav class="profile-jump" aria-label={$t('profileTab.jumpListLabel')}>
	{#each jumpTargets as target (target.id)}
		<a
			href={`#${target.id}`}
			class="profile-jump-chip"
			onclick={(event) => scrollToSection(event, target.id)}
		>
			<ChevronRight size={12} strokeWidth={2} aria-hidden="true" />
			{$t(target.labelKey)}
		</a>
	{/each}
</nav>

<!-- Card order in the DOM is the phone order, which is also the reading
     order: Account, Preferences, Assistant, Data & privacy, Your Activity,
     and the irreversible actions last. The desktop grid below lifts Account
     and the two trailing cards into the left column without reordering the
     DOM, so keyboard order and visual order agree at every width. -->
<div class="profile-grid">
	<div class="profile-col profile-col-lead">
		<!-- ═══ Your account — one card, one Save ═══ -->
		<section class="settings-card profile-identity" id="settings-section-account">
			<div class="settings-card-head">
				<div class="settings-card-head-text">
					<h2 class="settings-card-title">{$t('profileTab.accountTitle')}</h2>
				</div>
			</div>

			<div class="identity-person">
				<AvatarCircle
					{userId}
					name={userDisplayName}
					{profilePicture}
					{cacheBuster}
					size={56}
				/>
				<div class="identity-person-text">
					<p class="identity-name">{userDisplayName}</p>
					<p class="identity-email">{userEmail}</p>
					<div class="identity-photo-actions">
						<button
							type="button"
							class="btn-secondary btn-sm identity-photo-btn"
							aria-label={$t('settings_uploadPhotoA11y')}
							title={$t('settings_uploadPhoto')}
							onclick={onOpenPictureEditor}
						>
							<Upload size={13} strokeWidth={2} aria-hidden="true" />
							{$t('settings_uploadPhoto')}
						</button>
						{#if profilePicture}
							<button
								type="button"
								class="btn-danger btn-sm identity-photo-btn"
								aria-label={$t('settings_removePhotoA11y')}
								title={removingPhoto ? $t('settings_removing') : $t('settings_removePhoto')}
								onclick={onRemovePhoto}
								disabled={removingPhoto}
							>
								<Trash2 size={13} strokeWidth={2} aria-hidden="true" />
								{removingPhoto ? $t('settings_removing') : $t('settings_removePhoto')}
							</button>
						{/if}
					</div>
				</div>
			</div>

			<div class="identity-fields">
				<div>
					<label class="settings-label" for="name">{$t('settings_displayName')}</label>
					<input
						id="name"
						type="text"
						class="settings-input"
						bind:value={name}
						placeholder={$t('settings_yourName')}
						autocomplete="name"
					/>
				</div>
				<div>
					<label class="settings-label" for="email">{$t('settings_emailAddress')}</label>
					<input
						id="email"
						type="email"
						class="settings-input"
						bind:value={email}
						placeholder={$t('settings_emailExample')}
						autocomplete="email"
					/>
				</div>
			</div>

			<hr class="identity-rule" />

			<p class="settings-group-label identity-password-label">
				{$t('profileTab.passwordSectionLabel')}
			</p>
			<div class="identity-fields">
				<PasswordField
					id="current-pw"
					label={$t('settings_currentPassword')}
					bind:value={currentPassword}
					bind:shown={showCurrentPw}
					autocomplete="current-password"
					placeholder={$t('profileTab.currentPasswordPlaceholder')}
				/>
				<PasswordField
					id="new-pw"
					label={$t('settings_newPassword')}
					bind:value={newPassword}
					bind:shown={showNewPw}
					autocomplete="new-password"
					placeholder={$t('profileTab.newPasswordPlaceholder')}
				/>
				<PasswordField
					id="confirm-pw"
					label={$t('settings_confirmNewPassword')}
					bind:value={confirmPassword}
					bind:shown={showConfirmPw}
					autocomplete="new-password"
					placeholder={$t('profileTab.newPasswordPlaceholder')}
				/>
			</div>

			<div class="identity-foot">
				<button
					type="button"
					class="btn-primary identity-save"
					data-testid="account-save"
					onclick={onSaveAccount}
					disabled={accountSaving}
				>
					<Check size={14} strokeWidth={2} aria-hidden="true" />
					{accountSaving ? $t('settings_saving') : $t('profileTab.saveChanges')}
				</button>
				<button
					type="button"
					class="btn-ghost identity-discard"
					data-testid="account-discard"
					onclick={onDiscardAccount}
					disabled={accountSaving || !accountDirty}
				>{$t('profileTab.discard')}</button>
				<span class="identity-foot-spacer"></span>
				{#if savedAtLabel}
					<span class="identity-saved-at" data-testid="account-saved-at">
						{$t('profileTab.savedAt', { time: savedAtLabel })}
					</span>
				{/if}
			</div>
			<p class="identity-note">{$t('profileTab.passwordOptionalNote')}</p>
		</section>
	</div>

	<div class="profile-col profile-col-side">
		<!-- ═══ Preferences ═══ -->
		<section class="settings-card" id="settings-section-preferences">
			<div class="settings-card-head">
				<div class="settings-card-head-text">
					<h2 class="settings-card-title">{$t('settings_sectionPreferences')}</h2>
					<p class="settings-card-desc">{$t('profileTab.preferencesDesc')}</p>
				</div>
			</div>
			<div class="settings-rows">
				<div class="settings-row settings-row--stack">
					<div class="settings-row-text">
						<p class="settings-row-label">{$t('settings_defaultModel')}</p>
						<p class="settings-row-help">{$t('profileTab.defaultModelHelp')}</p>
					</div>
					<div class="settings-row-control">
						<select
							class="settings-select"
							data-testid="settings-default-model-select"
							aria-label={$t('settings_defaultModel')}
							value={selectedModel ?? ''}
							onchange={handleModelSelect}
						>
							<option value="">
								{$t('settings.systemDefaultModelResolved', { model: systemDefaultModelDisplayName })}
							</option>
							{#each explicitModelOptions as model (model.id)}
								<option value={model.id}>{model.displayName}</option>
							{/each}
						</select>
						{#if explicitModelOptions.length > 0}
							<span class="settings-row-hint">
								{$t('profileTab.otherModelsAvailable', { count: explicitModelOptions.length })}
							</span>
						{/if}
					</div>
				</div>

				{#if personalityProfiles.length > 0}
					<div class="settings-row settings-row--stack">
						<div class="settings-row-text">
							<p class="settings-row-label">{$t('settings_conversationStyle')}</p>
							<p class="settings-row-help">{$t('settings_conversationStyleNote')}</p>
						</div>
						<div class="settings-row-control">
							<select
								class="settings-select"
								data-testid="settings-conversation-style-select"
								aria-label={$t('settings_conversationStyle')}
								value={selectedPersonalityId ?? ''}
								onchange={handlePersonalitySelect}
							>
								<option value="">{$t('composerTools.defaultStyle')}</option>
								{#each personalityProfiles as profile (profile.id)}
									<option
										value={profile.id}
										title={getPersonalityProfileDisplayDescription(profile, $t)}
									>{getPersonalityProfileDisplayName(profile, $t)}</option>
								{/each}
							</select>
						</div>
					</div>
				{/if}

				<div class="settings-row settings-row--stack">
					<div class="settings-row-text">
						<p class="settings-row-label">{$t('settings_appearance')}</p>
						<p class="settings-row-help">{$t('profileTab.appearanceHelp')}</p>
					</div>
					<div class="settings-row-control">
						<div class="settings-seg" role="group" aria-label={$t('settings_appearance')}>
							{#each themeOptions as option (option.value)}
								<button
									type="button"
									class="settings-seg-option"
									aria-pressed={selectedTheme === option.value}
									onclick={() => onChangeTheme(option.value)}
								>{option.label}</button>
							{/each}
						</div>
					</div>
				</div>

				<div class="settings-row settings-row--stack">
					<div class="settings-row-text">
						<p class="settings-row-label">{$t('settings_interfaceLanguage')}</p>
						<p class="settings-row-help">{$t('settings_interfaceLanguageNote')}</p>
					</div>
					<div class="settings-row-control">
						<div class="settings-seg" role="group" aria-label={$t('settings_interfaceLanguage')}>
							{#each uiLanguageOptions as option (option.value)}
								<button
									type="button"
									class="settings-seg-option"
									aria-pressed={selectedUiLanguage === option.value}
									onclick={() => onChangeUiLanguage(option.value)}
								>{option.label}</button>
							{/each}
						</div>
					</div>
				</div>

				<div class="settings-row settings-row--stack">
					<div class="settings-row-text">
						<p class="settings-row-label">{$t('settings_titleLanguage')}</p>
						<p class="settings-row-help">{$t('profileTab.titleLanguageHelp')}</p>
					</div>
					<div class="settings-row-control">
						<div class="settings-seg" role="group" aria-label={$t('settings_titleLanguage')}>
							{#each titleLanguageOptions as option (option.value)}
								<button
									type="button"
									class="settings-seg-option"
									aria-pressed={selectedTitleLanguage === option.value}
									onclick={() => onChangeTitleLanguage(option.value)}
								>{option.label}</button>
							{/each}
						</div>
					</div>
				</div>
			</div>
		</section>

		<!-- ═══ Assistant behaviour ═══ -->
		<section class="settings-card" id="settings-section-assistant">
			<div class="settings-card-head">
				<div class="settings-card-head-text">
					<h2 class="settings-card-title">{$t('profileTab.assistantTitle')}</h2>
					<p class="settings-card-desc">{$t('profileTab.assistantDesc')}</p>
				</div>
			</div>
			<div class="settings-rows" id="settings-memory-card">
				<div class="settings-row">
					<div class="settings-row-text">
						<p class="settings-row-label">{$t('settings_memory')}</p>
						<p class="settings-row-help">{$t('settings_memoryHelp')}</p>
					</div>
					<div class="settings-row-control">
						<Toggle
							checked={memoryEnabled}
							disabled={memorySaving}
							ariaLabel={$t('settings_memory')}
							onChange={(next) => onChangeMemoryEnabled?.(next)}
						/>
						<span class="settings-row-hint">
							{memoryEnabled ? $t('profileTab.memoryOn') : $t('profileTab.memoryOff')}
						</span>
					</div>
				</div>

				<div class="settings-row settings-row--stack">
					<div class="settings-row-text">
						<p class="settings-row-label">{$t('settings_skillsManagerSummaryLabel')}</p>
						<p class="settings-row-help">
							{skillsEnabled ? $t('profileTab.skillsHelp') : $t('skills.disabled')}
						</p>
					</div>
					{#if skillsEnabled}
						<div class="settings-row-control">
							<span class="settings-pill settings-pill-active">
								{$t('profileTab.skillsCountActive', { count: skillsSummary.active })}
							</span>
							<span class="settings-pill">
								{$t('profileTab.skillsCountDisabled', { count: skillsSummary.disabled })}
							</span>
							<button
								type="button"
								class="settings-row-link"
								data-testid="skills-summary-card"
								aria-label={$t('settings_skillsManagerOpenA11y')}
								onclick={() => (skillsManagerOpen = true)}
							>
								{$t('profileTab.manageSkills')}
								<ChevronRight size={13} strokeWidth={2} aria-hidden="true" />
							</button>
						</div>
					{/if}
				</div>

				<div class="settings-row settings-row--stack">
					<div class="settings-row-text">
						<p class="settings-row-label">{$t('profileTab.memoryProfile')}</p>
						<p class="settings-row-help">{$t('profileTab.memoryProfileHelp')}</p>
					</div>
					<div class="settings-row-control">
						<a
							href="/knowledge"
							class="settings-row-link"
							aria-label={$t('profileTab.openKnowledgeBase')}
						>
							<BookOpen size={13} strokeWidth={2} aria-hidden="true" />
							{$t('profileTab.openKnowledgeBase')}
							<ChevronRight size={13} strokeWidth={2} aria-hidden="true" />
						</a>
					</div>
				</div>
			</div>
		</section>

		<!-- ═══ Data & privacy ═══ -->
		<section class="settings-card" id="settings-section-data-privacy">
			<div class="settings-card-head">
				<div class="settings-card-head-text">
					<h2 class="settings-card-title">{$t('settings_sectionDataPrivacy')}</h2>
					<p class="settings-card-desc">{$t('profileTab.dataPrivacyDesc')}</p>
				</div>
			</div>
			<!-- Outcome of a privacy action (archive prepared, memory cleared).
			     One strip, here, rather than one per card. -->
			{#if privacyControlsError}
				<p class="privacy-feedback privacy-feedback-error">{privacyControlsError}</p>
			{/if}
			{#if privacyControlsMessage}
				<p class="privacy-feedback privacy-feedback-ok">{privacyControlsMessage}</p>
			{/if}
			<div class="settings-rows">
				<div class="settings-row">
					<div class="settings-row-text">
						<p class="settings-row-label">{$t('settings_privacyPolicy')}</p>
						<p class="settings-row-help">{$t('profileTab.privacyPolicyHelp')}</p>
					</div>
					<div class="settings-row-control">
						<a
							href="/privacy"
							class="settings-row-link"
							aria-label={$t('settings_privacyPolicy')}
						>
							<ExternalLink size={13} strokeWidth={2} aria-hidden="true" />
							{$t('profileTab.readThePolicy')}
						</a>
					</div>
				</div>

				<div class="settings-row">
					<div class="settings-row-text">
						<p class="settings-row-label">{$t('chatgptImport.settingsButton')}</p>
						<p class="settings-row-help">{$t('profileTab.importHelp')}</p>
					</div>
					<div class="settings-row-control">
						<!-- Import folded into Data & privacy, where it belongs. The
						     component and its modal are unchanged; only its chrome
						     drops away so it can sit in a row. -->
						<SettingsDataImport {projects} variant="row" />
					</div>
				</div>

				<div class="settings-row">
					<div class="settings-row-text">
						<p class="settings-row-label">{$t('settings_downloadMyData')}</p>
						<p class="settings-row-help">{$t('profileTab.downloadHelp')}</p>
					</div>
					<div class="settings-row-control">
						<button
							type="button"
							class="btn-secondary btn-sm"
							aria-label={$t('settings_downloadMyData')}
							onclick={onOpenDownloadArchive}
							disabled={archiveLoading}
						>{$t('profileTab.prepareArchive')}</button>
					</div>
				</div>
			</div>
		</section>
	</div>

	<div class="profile-col profile-col-trail">
		<!-- ═══ Your Activity — summary, with the full view one click away ═══ -->
		<section class="settings-card" id="settings-section-your-activity">
			<div class="settings-card-head">
				<div class="settings-card-head-text">
					<h2 class="settings-card-title">{$t('settings_sectionYourActivity')}</h2>
					<p class="settings-card-desc">{$t('profileTab.activityDesc')}</p>
				</div>
				<div class="settings-card-actions">
					<button
						type="button"
						class="settings-row-link"
						data-testid="activity-open"
						onclick={() => (activityViewOpen = true)}
					>
						{$t('profileTab.activityOpen')}
						<ChevronRight size={13} strokeWidth={2} aria-hidden="true" />
					</button>
				</div>
			</div>
			{#if personal}
				<div class="activity-hero">
					<p class="activity-hero-value">{formatCompactCount(personal.totalTokens)}</p>
					<p class="activity-hero-label">{$t('profileTab.tokensAllTime')}</p>
					<p class="activity-hero-split">
						{$t('profileTab.tokensSplit', {
							completion: formatCompactCount(personal.outputTokens),
							reasoning: formatCompactCount(personal.reasoningTokens),
						})}
					</p>
					<div class="activity-split-bar" aria-hidden="true">
						<span style={`flex: ${Math.max(personal.outputTokens, 1)}`}></span>
						<span
							class="activity-split-bar-soft"
							style={`flex: ${Math.max(personal.reasoningTokens, 1)}`}
						></span>
					</div>
				</div>
				<div class="activity-stats">
					<div class="stat-card">
						<p class="stat-value">{personal.totalMessages.toLocaleString()}</p>
						<p class="stat-label">{$t('profileTab.messages')}</p>
					</div>
					<div class="stat-card">
						<p class="stat-value">{personal.chatCount.toLocaleString()}</p>
						<p class="stat-label">{$t('profileTab.conversations')}</p>
					</div>
					<div class="stat-card activity-stat-wide">
						<p class="stat-value activity-stat-model">
							{favoriteModelName ?? $t('profileTab.activityEmpty')}
						</p>
						<p class="stat-label">{$t('profileTab.mostUsedModel')}</p>
					</div>
				</div>
			{:else if personalAnalyticsLoading}
				<p class="settings-row-help">{$t('common.loading')}</p>
			{:else}
				<p class="settings-row-help">{$t('profileTab.activityEmpty')}</p>
			{/if}
		</section>

		<!-- ═══ Things that cannot be undone — last card on the page ═══ -->
		<section
			class="settings-card settings-card-danger"
			id="settings-section-danger"
			data-testid="profile-danger-card"
		>
			<div class="settings-card-head">
				<div class="settings-card-head-text">
					<h2 class="settings-card-title danger-title">
						<AlertTriangle size={14} strokeWidth={2} aria-hidden="true" />
						{$t('profileTab.dangerTitle')}
					</h2>
					<p class="settings-card-desc">{$t('profileTab.dangerDesc')}</p>
				</div>
			</div>
			<div class="settings-rows">
				<div class="settings-row">
					<div class="settings-row-text">
						<p class="settings-row-label">{$t('settings_clearMemoryAndKnowledge')}</p>
						<p class="settings-row-help">{$t('profileTab.clearMemoryHelp')}</p>
					</div>
					<div class="settings-row-control">
						<button
							type="button"
							class="btn-danger btn-sm"
							aria-label={$t('settings_clearMemoryAndKnowledge')}
							onclick={onOpenClearMemory}
							disabled={clearMemoryLoading}
						>{$t('profileTab.clearAction')}</button>
					</div>
				</div>
				<div class="settings-row">
					<div class="settings-row-text">
						<p class="settings-row-label">{$t('settings_clearWorkspaceData')}</p>
						<p class="settings-row-help">{$t('profileTab.clearWorkspaceHelp')}</p>
					</div>
					<div class="settings-row-control">
						<button
							type="button"
							class="btn-danger btn-sm"
							aria-label={$t('settings_clearWorkspaceData')}
							onclick={onOpenClearWorkspace}
							disabled={clearWorkspaceLoading}
						>{$t('profileTab.clearAction')}</button>
					</div>
				</div>
				<div class="settings-row">
					<div class="settings-row-text">
						<p class="settings-row-label settings-row-label-danger">
							{$t('settings_deleteAccountPrivacy')}
						</p>
						<p class="settings-row-help">{$t('profileTab.deleteAccountHelp')}</p>
					</div>
					<div class="settings-row-control">
						<button
							type="button"
							class="btn-danger btn-sm"
							aria-label={$t('settings_deleteAccountPrivacy')}
							onclick={onOpenDeleteModal}
						>
							<Trash2 size={12} strokeWidth={2} aria-hidden="true" />
							{$t('profileTab.deleteAction')}
						</button>
					</div>
				</div>
			</div>
		</section>
	</div>
</div>
{/if}

<style>
	/* ── Layout ────────────────────────────────────────────────────────
	   One column on a phone, in DOM order. At the desktop width the three
	   wrappers become a two-column grid: the lead card and the two trailing
	   cards stack in a 424px left column, the three preference cards fill
	   the right one. Nothing is reordered, so the tab order a keyboard sees
	   is the order the eye reads at every width. */
	.profile-grid {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
	}

	.profile-col {
		display: contents;
	}

	@media (min-width: 1024px) {
		.profile-grid {
			display: grid;
			grid-template-columns: 424px minmax(0, 1fr);
			grid-template-rows: min-content 1fr;
			gap: 0.875rem 1.5rem;
			align-items: start;
		}

		.profile-col {
			display: flex;
			flex-direction: column;
			gap: 0.875rem;
			min-width: 0;
		}

		.profile-col-lead {
			grid-column: 1;
			grid-row: 1;
		}

		.profile-col-side {
			grid-column: 2;
			grid-row: 1 / span 2;
		}

		.profile-col-trail {
			grid-column: 1;
			grid-row: 2;
			align-self: start;
		}
	}

	/* ── The phone jump-list ───────────────────────────────────────────
	   A single scrolling row with a fade at the right edge, so a chip that
	   continues past the viewport says so. Desktop has nothing left to
	   scroll to, so the strip is not drawn there at all. */
	.profile-jump {
		display: flex;
		flex-wrap: nowrap;
		overflow-x: auto;
		-webkit-overflow-scrolling: touch;
		gap: 0.5rem;
		padding-bottom: 0.625rem;
		margin-bottom: var(--space-sm);
		mask-image: linear-gradient(to right, #000 88%, transparent 100%);
		scrollbar-width: none;
	}

	.profile-jump::-webkit-scrollbar {
		display: none;
	}

	.profile-jump-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		flex: none;
		min-height: 44px;
		padding: 0 0.875rem;
		border-radius: var(--radius-full);
		border: 1px solid var(--border-default);
		background: var(--surface-overlay);
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--text-secondary);
		text-decoration: none;
		white-space: nowrap;
		transition:
			border-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out),
			background var(--duration-standard) var(--ease-out);
	}

	.profile-jump-chip:hover,
	.profile-jump-chip:focus-visible {
		border-color: var(--accent);
		color: var(--accent);
		background: var(--surface-elevated);
	}

	@media (min-width: 768px) {
		.profile-jump {
			display: none;
		}
	}

	/* ── Identity card ─────────────────────────────────────────────────── */
	.profile-identity {
		padding: var(--space-lg) 1.375rem;
	}

	.identity-person {
		display: flex;
		align-items: flex-start;
		gap: 1rem;
		margin-bottom: 1.125rem;
	}

	.identity-person-text {
		min-width: 0;
	}

	.identity-name {
		margin: 0;
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.identity-email {
		margin: 0.1875rem 0 0 0;
		font-family: var(--font-mono);
		font-size: 0.75rem;
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}

	.identity-photo-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4375rem;
		margin-top: 0.5625rem;
	}

	.identity-photo-btn {
		gap: 0.3125rem;
	}

	.identity-fields {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
	}

	.identity-rule {
		border: none;
		border-top: 1px solid var(--border-default);
		margin: 1.125rem 0;
	}

	.identity-password-label {
		margin: 0 0 0.625rem 0;
	}

	.identity-foot {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.625rem;
		margin-top: 1.125rem;
		padding-top: 1rem;
		border-top: 1px solid var(--border-default);
	}

	.identity-save {
		gap: 0.375rem;
	}

	.identity-foot-spacer {
		flex: 1 1 auto;
	}

	.identity-saved-at {
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	.identity-note {
		margin: 0.625rem 0 0 0;
		font-size: 0.75rem;
		line-height: 1.5;
		color: var(--text-muted);
	}

	.identity-discard:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	/* ── Row furniture ─────────────────────────────────────────────────── */
	.settings-row-hint {
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	.settings-row-link {
		display: inline-flex;
		align-items: center;
		gap: 0.3125rem;
		min-height: 30px;
		padding: 0.25rem 0.5625rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-page);
		font-family: inherit;
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--text-secondary);
		text-decoration: none;
		white-space: nowrap;
		cursor: pointer;
		transition:
			border-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out),
			background var(--duration-standard) var(--ease-out);
	}

	.settings-row-link:hover {
		border-color: var(--accent);
		color: var(--accent);
		background: color-mix(in srgb, var(--accent) 8%, var(--surface-page));
	}

	.settings-row-link:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.settings-pill {
		display: inline-flex;
		align-items: center;
		padding: 0.1875rem 0.5rem;
		border-radius: var(--radius-full);
		border: 1px solid var(--border-default);
		font-size: 0.6875rem;
		font-weight: 600;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.settings-pill-active {
		color: var(--accent);
		border-color: color-mix(in srgb, var(--accent) 38%, transparent);
		background: color-mix(in srgb, var(--accent) 10%, transparent);
	}

	.privacy-feedback {
		margin: 0 0 0.75rem 0;
		font-size: 0.8125rem;
		line-height: 1.5;
	}

	.privacy-feedback-error {
		color: var(--danger);
	}

	.privacy-feedback-ok {
		color: var(--success);
	}

	/* ── Your Activity summary ─────────────────────────────────────────── */
	.activity-hero {
		border: 1px solid var(--accent);
		border-radius: var(--radius-md);
		padding: 0.75rem;
		background: var(--surface-page);
	}

	.activity-hero-value {
		margin: 0;
		font-size: 1.5rem;
		font-weight: 700;
		line-height: 1.1;
		color: var(--accent);
	}

	.activity-hero-label {
		margin: 0.25rem 0 0 0;
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	.activity-hero-split {
		margin: 0.35rem 0 0 0;
		font-size: 0.7rem;
		color: var(--text-muted);
	}

	.activity-split-bar {
		display: flex;
		gap: 2px;
		margin-top: 0.5rem;
		height: 4px;
		border-radius: var(--radius-full);
		overflow: hidden;
	}

	.activity-split-bar span {
		background: var(--accent);
	}

	.activity-split-bar span.activity-split-bar-soft {
		background: color-mix(in srgb, var(--accent) 40%, transparent);
	}

	.activity-stats {
		display: grid;
		grid-template-columns: 1fr 1fr 1.5fr;
		gap: 0.625rem;
		margin-top: 0.625rem;
	}

	.activity-stat-model {
		font-size: 1rem;
		overflow-wrap: anywhere;
	}

	@media (max-width: 420px) {
		.activity-stats {
			grid-template-columns: 1fr 1fr;
		}

		.activity-stat-wide {
			grid-column: 1 / -1;
		}
	}

	/* ── Danger card ───────────────────────────────────────────────────── */
	.danger-title {
		display: flex;
		align-items: center;
		gap: 0.4375rem;
	}

	.danger-title :global(svg) {
		color: var(--danger);
		flex-shrink: 0;
	}

	/* ── Full-view overlays (Skills, Your Activity) ────────────────────── */
	.profile-fullview {
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
	}

	.profile-fullview-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.profile-fullview-title {
		margin: 0;
		font-size: 1.25rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	/* ── Phone: every target is at least 44px ──────────────────────────── */
	@media (max-width: 640px) {
		.profile-identity {
			padding: var(--space-md);
		}

		.identity-photo-btn,
		.settings-row-link {
			min-height: 44px;
		}

		.identity-photo-btn {
			flex: 1 1 0;
		}

		/* Sized to their labels, not to an equal share — "Save changes" wrapped
		   onto two lines when the two split the row evenly. */
		.identity-save {
			min-height: 44px;
			flex: 1 1 auto;
			white-space: nowrap;
		}

		.identity-discard {
			min-height: 44px;
			flex: 0 0 auto;
		}

		.settings-row {
			align-items: flex-start;
		}

		.settings-row :global(.btn-sm) {
			min-height: 44px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.profile-jump-chip,
		.settings-row-link {
			transition: none;
		}
	}
</style>
