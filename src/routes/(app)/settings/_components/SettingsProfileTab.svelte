<script lang=ts>
	import clsx from 'clsx';
	import AvatarCircle from '$lib/components/ui/AvatarCircle.svelte';
	import ModelIcon from '$lib/components/ui/ModelIcon.svelte';
	import { t } from '$lib/i18n';
	import {
		getPersonalityProfileDisplayDescription,
		getPersonalityProfileDisplayName,
	} from '$lib/utils/personality-profile-labels';
	import PasswordField from './PasswordField.svelte';
	import UserSkillsSettingsSurface from './UserSkillsSettingsSurface.svelte';
	import SettingsDataImport from './SettingsDataImport.svelte';
	import type { ModelId, UserModelPreference } from '$lib/types';
	import type { Project } from '$lib/types';

	type AvailableModel = { id: ModelId; displayName: string; iconUrl?: string | null };
	type Theme = 'system' | 'light' | 'dark';
	type TitleLanguage = 'auto' | 'en' | 'hu';
	type UiLanguage = 'en' | 'hu';

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
		name = $bindable(''),
		email = $bindable(''),
		profileSaving = false,
		profileMessage = '',
		profileError = '',
		onSaveProfile,
		currentPassword = $bindable(''),
		newPassword = $bindable(''),
		confirmPassword = $bindable(''),
		showCurrentPw = $bindable(false),
		showNewPw = $bindable(false),
		showConfirmPw = $bindable(false),
		passwordSaving = false,
		passwordMessage = '',
		passwordError = '',
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
		personalityProfiles = [],
		selectedPersonalityId = null,
		onChangePersonality = undefined,
		onOpenResetModal,
		onOpenDeleteModal,
		onForgetEverything,
		forgetEverythingLoading = false,
		forgetEverythingError = '',
		skillsEnabled = false,
		projects = [],
	}: {
		userId: string;
		userDisplayName: string;
		userEmail: string;
		profilePicture?: string | null;
		cacheBuster?: number;
		avatarColors: string[];
		avatarCount: number;
		selectedAvatar: number;
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
		personalityProfiles?: Array<{ id: string; name: string; description: string }>;
		selectedPersonalityId?: string | null;
		onChangePersonality?: ((id: string | null) => void) | undefined;
		onOpenResetModal: () => void;
		onOpenDeleteModal: () => void;
		onForgetEverything: () => void | Promise<void>;
		forgetEverythingLoading?: boolean;
		forgetEverythingError?: string;
		skillsEnabled?: boolean;
		projects?: Project[];
	} = $props();

	const systemDefaultModelDisplayName = $derived(
		availableModels.find((model) => model.id === systemDefaultModel)?.displayName ?? systemDefaultModel
	);
	const explicitModelOptions = $derived(
		availableModels.filter((model) => model.id !== systemDefaultModel)
	);
</script>

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
			<button class="btn-secondary text-sm" onclick={onOpenPictureEditor}>
				{$t('settings_uploadPhoto')}
			</button>
			<button class="btn-secondary text-sm" onclick={() => (showAvatarPicker = !showAvatarPicker)}>
				{showAvatarPicker ? $t('settings_done') : $t('settings_changeColor')}
			</button>
			{#if profilePicture}
				<button
					class="btn-ghost text-sm"
					style="color: var(--color-danger);"
					onclick={onRemovePhoto}
					disabled={removingPhoto}
				>
					{removingPhoto ? $t('settings_removing') : $t('settings_removePhoto')}
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

<section class="settings-card mb-4">
	<h2 class="settings-section-title">{$t('settings_preferences')}</h2>
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
				<p class="settings-label">{$t('composerTools.defaultStyleLabel')}</p>
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
			<p class="settings-label">{$t('settings_theme')}</p>
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
			<p class="settings-label">{$t('uiLanguage')}</p>
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

<style>
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
</style>

<SettingsDataImport {projects} />

<UserSkillsSettingsSurface {skillsEnabled} />

<section class="settings-card settings-card-danger mb-4">
	<h2 class="settings-section-title text-danger">{$t('settings_dangerZone')}</h2>
	<p class="mb-4 text-sm text-text-secondary">
		{$t('settings_resetDescription')}
	</p>
	{#if forgetEverythingError}
		<p class="mb-3 text-sm text-danger">{forgetEverythingError}</p>
	{/if}
	<div class="flex flex-wrap gap-2">
		<button class="btn-secondary" onclick={onOpenResetModal}>
			{$t('settings_resetAccount')}
		</button>
		<button class="btn-danger text-sm" onclick={onOpenDeleteModal}>
			{$t('settings_deleteAccount')}
		</button>
		<button class="btn-secondary" style="border-color: var(--danger); color: var(--danger);" onclick={onForgetEverything} disabled={forgetEverythingLoading}>
			{forgetEverythingLoading ? $t('settings_resetting') : $t('settings_resetMemory')}
		</button>
	</div>
</section>
