<script lang="ts">
import { onDestroy, onMount } from "svelte";
import { t } from "$lib/i18n";
import { ChevronDown } from "@lucide/svelte";
import {
	getPersonalityProfileDisplayDescription,
	getPersonalityProfileDisplayName,
	type PersonalityProfileLabelSource,
} from "$lib/utils/personality-profile-labels";
import type {
	Campaign,
	CampaignLocale,
	CampaignSetupControl,
	CampaignSlide,
} from "$lib/client/api/campaigns";
import type { ModelId, UserModelPreference } from "$lib/types";

type Theme = "system" | "light" | "dark";
type UiLanguage = "en" | "hu";
const CAMPAIGN_FALLBACK_DESKTOP_IMAGE =
	"/campaign-fallbacks/alfyai-brand-desktop.png";
const CAMPAIGN_FALLBACK_MOBILE_IMAGE =
	"/campaign-fallbacks/alfyai-brand-mobile.png";

type SetupPreferences = {
	availableModels: Array<{ id: ModelId; displayName: string }>;
	effectiveModel: ModelId;
	systemDefaultModel?: ModelId;
	selectedModel: UserModelPreference;
	selectedTheme: Theme;
	selectedUiLanguage: UiLanguage;
	personalityProfiles?: Array<PersonalityProfileLabelSource & { id: string }>;
	selectedPersonalityId?: string | null;
	onChangeUiLanguage: (language: UiLanguage) => void | Promise<void>;
	onChangeTheme: (theme: Theme) => void | Promise<void>;
	onChangeModel: (model: UserModelPreference) => void | Promise<void>;
	onChangePersonality?: (id: string | null) => void | Promise<void>;
};

let {
	campaign = null,
	locale = "en",
	preview = false,
	inline = false,
	slideIndex = 0,
	setupPreferences = undefined,
	onSlideChange,
	onSlideView,
	onClose,
	onSkip,
	onFinish,
	onInternalAction,
}: {
	campaign?: Campaign | null;
	locale?: CampaignLocale;
	preview?: boolean;
	inline?: boolean;
	slideIndex?: number;
	setupPreferences?: SetupPreferences;
	onSlideChange?: (index: number) => void;
	onSlideView?: (slide: CampaignSlide, index: number) => void;
	onClose?: () => void;
	onSkip?: () => void;
	onFinish?: () => void;
	onInternalAction?: (action: string) => void;
} = $props();

let localSlideIndex = $state(0);
let dialogRef = $state<HTMLElement | null>(null);
let initialFocusRef = $state<HTMLButtonElement | null>(null);
let previousFocus: HTMLElement | null = null;

$effect(() => {
	localSlideIndex = slideIndex;
});

let slides = $derived(
	[...(campaign?.slides ?? [])].sort(
		(a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0),
	),
);
let safeSlideIndex = $derived(
	Math.min(Math.max(localSlideIndex, 0), Math.max(slides.length - 1, 0)),
);
let currentSlide = $derived(slides[safeSlideIndex] ?? null);
let isFinalSlide = $derived(safeSlideIndex >= slides.length - 1);
let isSetupSlide = $derived(
	Boolean(
		currentSlide &&
			campaign?.type === "first_run_onboarding" &&
			(currentSlide.layoutType ?? currentSlide.kind ?? currentSlide.type) ===
				"setup",
	),
);
let enabledSetupControls = $derived<CampaignSetupControl[]>(
	currentSlide?.setupControls ?? [],
);
let showSetupControls = $derived(
	Boolean(isSetupSlide && setupPreferences && enabledSetupControls.length > 0),
);
let systemDefaultModel = $derived(
	setupPreferences?.systemDefaultModel ?? setupPreferences?.effectiveModel,
);
let systemDefaultModelDisplayName = $derived(
	setupPreferences?.availableModels.find(
		(model) => model.id === systemDefaultModel,
	)?.displayName ??
		systemDefaultModel ??
		"",
);
let explicitModelOptions = $derived(
	setupPreferences?.availableModels.filter(
		(model) => model.id !== systemDefaultModel,
	) ?? [],
);
let currentDesktopUploadedImageUrl = $derived(
	assetUrl(currentSlide, "desktop"),
);
let currentMobileUploadedImageUrl = $derived(assetUrl(currentSlide, "mobile"));
let hasCurrentUploadedImage = $derived(
	Boolean(currentDesktopUploadedImageUrl || currentMobileUploadedImageUrl),
);
let currentActionDestination = $derived(
	currentSlide?.actionDestination ?? currentSlide?.actionUrl ?? null,
);
let isInternalAction = $derived(
	Boolean(currentActionDestination?.startsWith("internal:")),
);
let currentDesktopImageUrl = $derived(
	campaignImageUrl(currentSlide, "desktop"),
);
let currentMobileImageUrl = $derived(campaignImageUrl(currentSlide, "mobile"));
let currentImageKey = $derived(
	currentSlide
		? `${currentSlide.id ?? safeSlideIndex}:${currentDesktopImageUrl}:${currentMobileImageUrl}`
		: "",
);
let settledImageKey = $state("");
let trackedImageKey = $state("");
const preloadedImageUrls = new Set<string>();
const preloadedImages: HTMLImageElement[] = [];

$effect(() => {
	if (!currentSlide || preview) return;
	onSlideView?.(currentSlide, safeSlideIndex);
});

$effect(() => {
	if (currentImageKey === trackedImageKey) return;
	trackedImageKey = currentImageKey;
	settledImageKey = "";
});

$effect(() => {
	const nextSlide = slides[safeSlideIndex + 1] ?? null;
	preloadCampaignImage(campaignImageUrl(nextSlide, "desktop"));
	preloadCampaignImage(campaignImageUrl(nextSlide, "mobile"));
});

function localized(
	slide: CampaignSlide | null,
	field: "title" | "body" | "alt" | "actionLabel",
) {
	if (!slide) return "";
	const suffix = locale === "hu" ? "Hu" : "En";
	const fallbackSuffix = locale === "hu" ? "En" : "Hu";
	const objectField = field === "alt" ? "altText" : field;
	const localizedObject = slide[objectField as keyof CampaignSlide] as
		| Partial<Record<CampaignLocale, string | null>>
		| null
		| undefined;
	return (
		localizedObject?.[locale] ??
		localizedObject?.[locale === "hu" ? "en" : "hu"] ??
		(slide[`${field}${suffix}` as keyof CampaignSlide] as
			| string
			| null
			| undefined) ??
		(slide[`${field}${fallbackSuffix}` as keyof CampaignSlide] as
			| string
			| null
			| undefined) ??
		""
	);
}

function assetUrl(
	slide: CampaignSlide | null,
	preferredVariant: "desktop" | "mobile" = "desktop",
) {
	if (!slide) return "";
	const primary =
		preferredVariant === "desktop" ? slide.desktopAsset : slide.mobileAsset;
	const fallback =
		preferredVariant === "desktop" ? slide.mobileAsset : slide.desktopAsset;
	const asset =
		primary?.url ??
		fallback?.url ??
		slide.assets?.find((candidate) => candidate.variant === preferredVariant)
			?.url ??
		slide.assets?.[0]?.url;
	if (asset) return asset;
	const assetId =
		(preferredVariant === "desktop"
			? (slide.desktopCropAssetId ??
				slide.desktopAssetId ??
				slide.desktopAsset?.id)
			: (slide.mobileCropAssetId ??
				slide.mobileAssetId ??
				slide.mobileAsset?.id)) ??
		(preferredVariant === "desktop"
			? (slide.mobileCropAssetId ??
				slide.mobileAssetId ??
				slide.mobileAsset?.id)
			: (slide.desktopCropAssetId ??
				slide.desktopAssetId ??
				slide.desktopAsset?.id)) ??
		slide.assets?.find((candidate) => candidate.variant === preferredVariant)
			?.id ??
		slide.assets?.[0]?.id;
	return assetId
		? `/api/campaign-assets/${encodeURIComponent(assetId)}/content`
		: "";
}

function campaignImageUrl(
	slide: CampaignSlide | null,
	preferredVariant: "desktop" | "mobile",
) {
	if (!slide) return "";
	return (
		assetUrl(slide, preferredVariant) ||
		(preferredVariant === "desktop"
			? CAMPAIGN_FALLBACK_DESKTOP_IMAGE
			: CAMPAIGN_FALLBACK_MOBILE_IMAGE)
	);
}

function markImageSettled(key: string) {
	if (key === currentImageKey) settledImageKey = key;
}

function preloadCampaignImage(url: string) {
	if (!url || preloadedImageUrls.has(url) || typeof Image === "undefined")
		return;
	preloadedImageUrls.add(url);
	const image = new Image();
	image.src = url;
	preloadedImages.push(image);
}

function goTo(index: number) {
	if (slides.length === 0) return;
	localSlideIndex = Math.min(Math.max(index, 0), slides.length - 1);
	onSlideChange?.(localSlideIndex);
}

function closeAsSkip() {
	onSkip?.();
	onClose?.();
	restoreFocus();
}

function hasSetupControl(control: CampaignSetupControl) {
	return enabledSetupControls.includes(control);
}

function handlePersonalitySelect(event: Event) {
	const value = (event.currentTarget as HTMLSelectElement).value;
	void setupPreferences?.onChangePersonality?.(value || null);
}

function handleModelSelect(event: Event) {
	const value = (event.currentTarget as HTMLSelectElement).value;
	void setupPreferences?.onChangeModel(
		value ? (value as UserModelPreference) : null,
	);
}

function focusableElements() {
	return Array.from(
		dialogRef?.querySelectorAll<HTMLElement>(
			'a[href]:not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])',
		) ?? [],
	).filter((element) => !element.hasAttribute("aria-hidden"));
}

function restoreFocus() {
	if (inline) return;
	previousFocus?.focus?.();
	previousFocus = null;
}

function handleKeydown(event: KeyboardEvent) {
	if (inline) return;
	if (event.key === "Escape") {
		event.preventDefault();
		closeAsSkip();
		return;
	}
	if (event.key !== "Tab") return;

	const focusable = focusableElements();
	if (focusable.length === 0) {
		event.preventDefault();
		return;
	}
	const first = focusable[0];
	const last = focusable[focusable.length - 1];
	if (event.shiftKey && document.activeElement === first) {
		last.focus();
		event.preventDefault();
	} else if (!event.shiftKey && document.activeElement === last) {
		first.focus();
		event.preventDefault();
	} else if (!dialogRef?.contains(document.activeElement)) {
		first.focus();
		event.preventDefault();
	}
}

onMount(() => {
	if (inline) return;
	previousFocus = document.activeElement as HTMLElement | null;
	setTimeout(() => {
		(initialFocusRef ?? focusableElements()[0])?.focus();
	}, 0);
});

onDestroy(() => {
	restoreFocus();
});
</script>

<svelte:window onkeydown={handleKeydown} />

<section
	bind:this={dialogRef}
	class:campaign-shell={!inline}
	class:campaign-inline={inline}
	role={!inline ? 'dialog' : undefined}
	aria-modal={!inline ? 'true' : undefined}
	aria-label={preview ? $t('campaignModal.previewLabel') : $t('campaignModal.label')}
>
	<div class="campaign-modal-surface">
		<header class="campaign-modal-header">
			<h2 class="sr-only">{campaign?.name || $t('campaignModal.untitled')}</h2>
			{#if !inline}
				<button
					bind:this={initialFocusRef}
					type="button"
					class="campaign-icon-button"
					aria-label={$t('common.close')}
					title={$t('common.close')}
					onclick={closeAsSkip}
				>
					×
				</button>
			{/if}
		</header>

		{#if currentSlide}
			<nav class="campaign-progress" aria-label={$t('campaignModal.progressLabel')}>
				{#each slides as slide, index}
					<button
						type="button"
						class="campaign-progress-segment"
						class:campaign-progress-segment-active={index <= safeSlideIndex}
						aria-label={$t('campaignModal.progressSlide', { current: index + 1, total: slides.length })}
						aria-current={index === safeSlideIndex ? 'step' : undefined}
						onclick={() => goTo(index)}
					>
						<span class="sr-only">{localized(slide, 'title') || $t('campaignModal.progressSlide', { current: index + 1, total: slides.length })}</span>
					</button>
				{/each}
			</nav>

			<div class="campaign-modal-body">
				{#if currentDesktopImageUrl || currentMobileImageUrl}
					<div class="campaign-image-frame" aria-busy={settledImageKey !== currentImageKey}>
						{#key currentImageKey}
							<picture class="campaign-picture" class:campaign-picture-loaded={settledImageKey === currentImageKey}>
								{#if currentMobileImageUrl}
									<source media="(max-width: 640px)" srcset={currentMobileImageUrl} />
								{/if}
								<img
									class="campaign-image"
									src={currentDesktopImageUrl || currentMobileImageUrl}
									alt={hasCurrentUploadedImage ? localized(currentSlide, 'alt') : ''}
									onload={() => markImageSettled(currentImageKey)}
									onerror={() => markImageSettled(currentImageKey)}
								/>
							</picture>
						{/key}
						{#if settledImageKey !== currentImageKey}
							<div class="campaign-image-loading" aria-hidden="true"></div>
						{/if}
					</div>
				{:else}
					<div class="campaign-image-empty" aria-hidden="true">
						{$t('campaignModal.noImage')}
					</div>
				{/if}

				<div class="campaign-copy">
					<div class="campaign-copy-header">
						<h3 class="campaign-slide-title">{localized(currentSlide, 'title')}</h3>
						<p class="text-sm leading-6 text-text-secondary">{localized(currentSlide, 'body')}</p>
					</div>
					{#if localized(currentSlide, 'actionLabel')}
						{#if isInternalAction}
							<button
								type="button"
								class="campaign-action-link"
								disabled={preview}
								onclick={() => {
									if (preview) return;
									const action = currentActionDestination?.replace(/^internal:/, '') ?? '';
									onInternalAction?.(action);
								}}
							>
								{localized(currentSlide, 'actionLabel')}
							</button>
						{:else}
							<a
								class="campaign-action-link"
								href={currentSlide.actionDestination || currentSlide.actionUrl || '#'}
								aria-disabled={preview || !(currentSlide.actionDestination || currentSlide.actionUrl)}
								onclick={(event) => {
									if (preview || !(currentSlide.actionDestination || currentSlide.actionUrl)) event.preventDefault();
								}}
							>
								{localized(currentSlide, 'actionLabel')}
							</a>
						{/if}
					{/if}

					{#if showSetupControls && setupPreferences}
						<div class="campaign-setup-controls" aria-label={$t('campaignModal.setup.label')}>
							{#if hasSetupControl('ui_language')}
								<section class="campaign-setup-group" aria-labelledby="campaign-setup-language">
									<p id="campaign-setup-language" class="campaign-setup-label">{$t('uiLanguage')}</p>
									<div class="campaign-segmented">
										<button
											type="button"
											class:active={setupPreferences.selectedUiLanguage === 'en'}
											onclick={() => setupPreferences?.onChangeUiLanguage('en')}
										>
											{$t('english')}
										</button>
										<button
											type="button"
											class:active={setupPreferences.selectedUiLanguage === 'hu'}
											onclick={() => setupPreferences?.onChangeUiLanguage('hu')}
										>
											{$t('hungarian')}
										</button>
									</div>
								</section>
							{/if}

							{#if hasSetupControl('theme')}
								<section class="campaign-setup-group" aria-labelledby="campaign-setup-theme">
									<p id="campaign-setup-theme" class="campaign-setup-label">{$t('settings_theme')}</p>
									<div class="campaign-segmented">
										{#each [
											{ value: 'system' as const, label: $t('settings_system') },
											{ value: 'light' as const, label: $t('settings_light') },
											{ value: 'dark' as const, label: $t('settings_dark') },
										] as theme}
											<button
												type="button"
												class:active={setupPreferences.selectedTheme === theme.value}
												onclick={() => setupPreferences?.onChangeTheme(theme.value)}
											>
												{theme.label}
											</button>
										{/each}
									</div>
								</section>
							{/if}

							{#if hasSetupControl('model_default')}
								<section class="campaign-setup-group" aria-labelledby="campaign-setup-model">
									<p id="campaign-setup-model" class="campaign-setup-label">{$t('settings_defaultModel')}</p>
									<div class="campaign-select-wrap">
										<select
											class="campaign-select"
											value={setupPreferences.selectedModel ?? ''}
											onchange={handleModelSelect}
											aria-labelledby="campaign-setup-model"
											title={$t('settings.systemDefaultModelResolved', { model: systemDefaultModelDisplayName })}
										>
											<option value="">
												{$t('settings.systemDefaultModel')} · {systemDefaultModelDisplayName}
											</option>
										{#each explicitModelOptions as model}
											<option value={model.id}>{model.displayName}</option>
										{/each}
									</select>
									<span class="campaign-select-arrow">
										<ChevronDown size={16} strokeWidth={2.4} aria-hidden="true" />
									</span>
								</div>
							</section>
						{/if}

						{#if hasSetupControl('ai_style')}
								<section class="campaign-setup-group" aria-labelledby="campaign-setup-style">
									<p id="campaign-setup-style" class="campaign-setup-label">{$t('composerTools.defaultStyleLabel')}</p>
									<div class="campaign-select-wrap">
										<select
											class="campaign-select"
											value={setupPreferences.selectedPersonalityId ?? ''}
											onchange={handlePersonalitySelect}
											aria-labelledby="campaign-setup-style"
										>
											<option value="">{$t('composerTools.defaultStyle')}</option>
										{#each setupPreferences.personalityProfiles ?? [] as profile}
											<option value={profile.id} title={getPersonalityProfileDisplayDescription(profile, $t)}>
												{getPersonalityProfileDisplayName(profile, $t)}
											</option>
										{/each}
									</select>
									<span class="campaign-select-arrow">
										<ChevronDown size={16} strokeWidth={2.4} aria-hidden="true" />
									</span>
								</div>
							</section>
						{/if}
					</div>
				{/if}
			</div>
		</div>

			<footer class="campaign-footer">
				<div>
					{#if !isFinalSlide}
						<button type="button" class="campaign-skip-button" onclick={closeAsSkip}>
							{$t('campaignModal.skip')}
						</button>
					{/if}
				</div>
				<span class="campaign-slide-count">
					{$t('campaignModal.slideCount', { current: safeSlideIndex + 1, total: slides.length })}
				</span>
				<div class="campaign-footer-actions">
					<button
						type="button"
						class="campaign-secondary-button"
						disabled={safeSlideIndex === 0}
						onclick={() => goTo(safeSlideIndex - 1)}
					>
						{$t('campaignModal.back')}
					</button>
					{#if isFinalSlide}
						<button type="button" class="campaign-primary-button" onclick={() => onFinish?.()}>
							{$t('campaignModal.finish')}
						</button>
					{:else}
						<button type="button" class="campaign-primary-button" onclick={() => goTo(safeSlideIndex + 1)}>
							{$t('campaignModal.next')}
						</button>
					{/if}
				</div>
			</footer>
		{:else}
			<div class="px-lg py-xl text-sm text-text-muted">
				{$t('campaignModal.empty')}
			</div>
		{/if}
	</div>
</section>

<style>
	.campaign-shell {
		position: fixed;
		inset: 0;
		z-index: 50;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(0, 0, 0, 0.42);
		backdrop-filter: blur(10px);
		padding: var(--space-lg);
	}

	.campaign-inline {
		width: 100%;
	}

	.campaign-modal-surface {
		position: relative;
		display: flex;
		max-height: min(900px, calc(100dvh - 2 * var(--space-lg)));
		flex-direction: column;
		gap: var(--space-md);
		overflow: hidden;
		width: 100%;
		max-width: 680px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface-page);
		padding: var(--space-md);
		box-shadow: 0 18px 50px rgba(0, 0, 0, 0.22);
	}

	.campaign-inline .campaign-modal-surface {
		max-width: none;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
	}

	.campaign-modal-header {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		justify-content: flex-end;
		min-height: 0.5rem;
		padding: 0;
	}

	.campaign-icon-button {
		display: inline-flex;
		width: 2rem;
		height: 2rem;
		padding: 0;
		cursor: pointer;
		align-items: center;
		justify-content: center;
		border-radius: 6px;
		color: var(--text-muted);
		font-size: 1.25rem;
		line-height: 0;
		transition:
			background 0.15s ease,
			color 0.15s ease;
	}

	.campaign-icon-button:hover {
		background: var(--surface-overlay);
		color: var(--text-primary);
	}

	.campaign-progress {
		display: flex;
		flex-shrink: 0;
		gap: 4px;
		padding: 0;
	}

	.campaign-progress-segment {
		height: 4px;
		flex: 1;
		cursor: pointer;
		border-radius: 999px;
		background: var(--surface-overlay);
		transition: background 0.15s ease;
	}

	.campaign-progress-segment:hover,
	.campaign-progress-segment-active {
		background: var(--accent);
	}

	.campaign-modal-body {
		min-height: 0;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: var(--space-lg);
		padding: 0;
	}

	.campaign-image-frame,
	.campaign-image,
	.campaign-image-empty {
		display: block;
		width: 100%;
	}

	.campaign-image-frame,
	.campaign-image-empty {
		position: relative;
		flex-shrink: 0;
		overflow: hidden;
		width: min(100%, 520px);
		aspect-ratio: 16 / 10;
		margin: 0 auto;
		border-radius: 8px;
		background: var(--surface-overlay);
	}

	.campaign-picture {
		display: block;
		width: 100%;
		height: 100%;
		opacity: 0;
		transition: opacity 0.16s ease;
	}

	.campaign-picture-loaded {
		opacity: 1;
	}

	.campaign-image {
		height: 100%;
		background: var(--surface-overlay);
		object-fit: contain;
		object-position: center;
	}

	.campaign-image-loading {
		position: absolute;
		inset: 0;
		background:
			linear-gradient(
				100deg,
				transparent 0%,
				color-mix(in srgb, var(--surface-page) 42%, transparent) 50%,
				transparent 100%
			),
			var(--surface-overlay);
		background-size: 180% 100%;
		animation: campaign-image-loading 1.1s ease-in-out infinite;
	}

	.campaign-image-empty {
		display: grid;
		place-items: center;
		color: var(--text-muted);
		font-size: 0.875rem;
	}

	.campaign-copy {
		display: flex;
		flex-direction: column;
		gap: var(--space-lg);
		border: 1px solid var(--border);
		border-radius: 8px;
		background: color-mix(in srgb, var(--surface-overlay) 28%, transparent);
		padding: var(--space-md);
	}

	.campaign-copy-header {
		display: grid;
		gap: var(--space-xs);
	}

	.campaign-slide-title {
		color: var(--text-primary);
		font-size: 1.125rem;
		font-weight: 700;
		line-height: 1.25;
	}

	.campaign-action-link {
		align-self: flex-start;
		display: inline-flex;
		min-height: 2.15rem;
		cursor: pointer;
		align-items: center;
		justify-content: center;
		border: 1px solid color-mix(in srgb, var(--accent) 44%, var(--border));
		border-radius: 6px;
		background: color-mix(in srgb, var(--accent) 7%, transparent);
		padding: 0.4rem 0.75rem;
		color: var(--accent);
		font-size: 0.875rem;
		font-weight: 700;
		text-decoration: none;
		transition:
			background 0.15s ease,
			border-color 0.15s ease,
			color 0.15s ease,
			transform 0.15s ease;
	}

	.campaign-action-link:hover {
		border-color: color-mix(in srgb, var(--accent) 62%, var(--border));
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		transform: translateY(-1px);
	}

	.campaign-action-link[aria-disabled='true'] {
		cursor: default;
		opacity: 0.62;
	}

	.campaign-action-link[aria-disabled='true']:hover {
		transform: none;
	}

	.campaign-setup-controls {
		display: grid;
		gap: var(--space-md);
		padding-top: var(--space-xs);
	}

	@media (min-width: 520px) {
		.campaign-setup-controls {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	.campaign-setup-group {
		display: grid;
		gap: var(--space-sm);
	}

	.campaign-setup-label {
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text-muted);
		text-transform: uppercase;
	}

	.campaign-segmented {
		display: flex;
		gap: var(--space-xs);
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface-overlay);
		padding: 3px;
	}

	.campaign-segmented button {
		flex: 1 1 auto;
		min-height: 2.1rem;
		cursor: pointer;
		border-radius: 6px;
		padding: 0.35rem 0.6rem;
		color: var(--text-secondary);
		font-size: 0.875rem;
		font-weight: 600;
		transition:
			background 0.15s ease,
			color 0.15s ease,
			box-shadow 0.15s ease;
	}

	.campaign-segmented button:hover {
		color: var(--text-primary);
	}

	.campaign-segmented button.active {
		background: var(--surface-page);
		color: var(--text-primary);
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
	}

	.campaign-select-wrap {
		position: relative;
	}

	.campaign-select {
		appearance: none;
		width: 100%;
		min-height: 2.45rem;
		cursor: pointer;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface-overlay);
		padding: 0.45rem 2.6rem 0.45rem 0.75rem;
		color: var(--text-primary);
		font-size: 0.875rem;
		font-weight: 600;
		transition:
			border-color 0.15s ease,
			background 0.15s ease,
			box-shadow 0.15s ease;
	}

	.campaign-select:hover {
		border-color: var(--border-focus);
		background: color-mix(in srgb, var(--surface-overlay) 82%, var(--surface-page));
	}

	.campaign-select:focus {
		border-color: var(--border-focus);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 18%, transparent);
		outline: none;
	}

	.campaign-select-arrow {
		pointer-events: none;
		position: absolute;
		top: 50%;
		right: 0.9rem;
		color: var(--text-muted);
		transform: translateY(-50%);
	}

	.campaign-footer {
		display: grid;
		flex-shrink: 0;
		grid-template-columns: 1fr auto 1fr;
		align-items: center;
		gap: var(--space-md);
		border-top: 1px solid var(--border);
		background: transparent;
		padding: var(--space-md) 0 0;
	}

	.campaign-footer-actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-md);
	}

	.campaign-slide-count {
		font-size: 0.75rem;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.campaign-skip-button,
	.campaign-secondary-button,
	.campaign-primary-button {
		min-height: 2.15rem;
		cursor: pointer;
		border-radius: 6px;
		padding: 0.45rem 0.95rem;
		font-size: 0.875rem;
		font-weight: 700;
		transition:
			background 0.15s ease,
			border-color 0.15s ease,
			color 0.15s ease,
			opacity 0.15s ease;
	}

	.campaign-skip-button {
		color: var(--text-muted);
	}

	.campaign-skip-button:hover {
		background: var(--surface-overlay);
		color: var(--text-primary);
	}

	.campaign-secondary-button {
		border: 1px solid var(--border);
		color: var(--text-secondary);
	}

	.campaign-secondary-button:hover:not(:disabled) {
		border-color: var(--border-focus);
		color: var(--text-primary);
	}

	.campaign-secondary-button:disabled {
		cursor: not-allowed;
		opacity: 0.45;
	}

	.campaign-primary-button {
		background: var(--accent);
		color: white;
	}

	.campaign-primary-button:hover {
		background: var(--accent-hover);
	}

	button:focus-visible,
	a:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	@keyframes campaign-image-loading {
		from {
			background-position: 140% 0;
		}
		to {
			background-position: -80% 0;
		}
	}

	@media (max-width: 640px) {
		.campaign-shell {
			align-items: center;
			padding: max(var(--space-sm), env(safe-area-inset-top)) var(--space-sm)
				max(var(--space-sm), env(safe-area-inset-bottom));
		}

		.campaign-modal-surface {
			width: calc(100% - var(--space-xl));
			max-height: min(94dvh, calc(100dvh - max(var(--space-md), env(safe-area-inset-top)) - max(var(--space-md), env(safe-area-inset-bottom))));
			max-width: 430px;
			border-radius: 8px;
			gap: var(--space-sm);
			padding: var(--space-sm);
		}

		.campaign-modal-header {
			padding: 0;
		}

		.campaign-progress {
			padding: 0;
		}

		.campaign-modal-body {
			gap: var(--space-md);
			padding: 0;
		}

		.campaign-copy {
			gap: var(--space-md);
			padding: var(--space-sm);
		}

		.campaign-image-frame,
		.campaign-image-empty {
			aspect-ratio: 9 / 16;
			width: min(58vw, 190px);
		}

		.campaign-slide-title {
			font-size: 1rem;
		}

		.campaign-footer {
			grid-template-columns: 1fr auto;
			align-items: stretch;
			gap: var(--space-md);
			padding: var(--space-sm) 0 0;
			padding-bottom: 0;
		}

		.campaign-segmented button {
			min-height: 2.1rem;
			padding: 0.35rem 0.55rem;
			font-size: 0.875rem;
		}

		.campaign-slide-count {
			display: none;
		}

		.campaign-footer-actions {
			justify-content: flex-end;
		}

		.campaign-footer-actions button,
		.campaign-skip-button {
			flex: 1;
		}
	}
</style>
