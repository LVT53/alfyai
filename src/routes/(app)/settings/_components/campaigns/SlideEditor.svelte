<script module lang="ts">
export type EditorSlide = {
	localId: string;
	titleEn?: string | null;
	titleHu?: string | null;
	bodyEn?: string | null;
	bodyHu?: string | null;
	altEn?: string | null;
	altHu?: string | null;
	actionLabelEn?: string | null;
	actionLabelHu?: string | null;
	actionUrl?: string | null;
	desktopAssetId?: string | null;
	mobileAssetId?: string | null;
	desktopSourceAssetId?: string | null;
	mobileSourceAssetId?: string | null;
};

export type AssetDetails = {
	filename: string;
	sizeBytes: number;
	sourceAssetId: string | null;
};
</script>

<script lang="ts">
import { TriangleAlert } from "@lucide/svelte";
import InfoTooltip from "$lib/components/ui/InfoTooltip.svelte";
import type { I18nKey } from "$lib/i18n";
import type { CampaignAssetVariant } from "$lib/client/api/campaign-assets";
import { t } from "$lib/i18n";
import {
	ALLOWED_ACTION_DESTINATIONS,
	type CampaignChecklist,
	type ChecklistLocale,
	isAllowedActionDestination,
	slideFieldFailures,
	slideLocaleHasFailure,
} from "./campaign-checklist";
import OverflowMenu, { type OverflowMenuItem } from "./OverflowMenu.svelte";
import SlideAssetBlock from "./SlideAssetBlock.svelte";

const BODY_GUIDE_LENGTH = 600;

let {
	slide,
	slideNumber,
	locale,
	editable = true,
	checklist,
	menuItems,
	menuAttention = false,
	assetDetails = {},
	uploadingVariant = null,
	onUpdate,
	onLocaleChange,
	onAssetUpload,
	onAssetRecrop,
	onAssetRemove,
}: {
	slide: EditorSlide;
	slideNumber: number;
	locale: ChecklistLocale;
	editable?: boolean;
	checklist: CampaignChecklist;
	menuItems: OverflowMenuItem[];
	menuAttention?: boolean;
	assetDetails?: Record<string, AssetDetails | undefined>;
	uploadingVariant?: CampaignAssetVariant | null;
	onUpdate: (patch: Partial<EditorSlide>) => void;
	onLocaleChange: (locale: ChecklistLocale) => void;
	onAssetUpload: (variant: CampaignAssetVariant, file: File) => void;
	onAssetRecrop: (variant: CampaignAssetVariant) => void;
	onAssetRemove: (variant: CampaignAssetVariant) => void;
} = $props();

const DESTINATION_LABELS: Record<string, string> = {
	"/": "admin.campaigns.destination.home",
	"/chat": "admin.campaigns.destination.chat",
	"/knowledge": "admin.campaigns.destination.knowledge",
	"/settings": "admin.campaigns.destination.settings",
	"/settings/profile": "admin.campaigns.destination.profile",
	"/settings/admin": "admin.campaigns.destination.admin",
};

let title = $derived((locale === "en" ? slide.titleEn : slide.titleHu) ?? "");
let body = $derived((locale === "en" ? slide.bodyEn : slide.bodyHu) ?? "");
let altText = $derived((locale === "en" ? slide.altEn : slide.altHu) ?? "");
let actionLabel = $derived(
	(locale === "en" ? slide.actionLabelEn : slide.actionLabelHu) ?? "",
);
let failures = $derived(slideFieldFailures(checklist, slide.localId));
let languageName = $derived(
	locale === "hu"
		? $t("admin.campaigns.language.hu")
		: $t("admin.campaigns.language.en"),
);
// A destination the select cannot offer — a legacy value such as
// "internal:chatgpt-import", or an allow-listed path carrying a query string.
// It is added to the select as its own option rather than silently dropped.
let unknownDestination = $derived(
	Boolean(
		slide.actionUrl &&
			!ALLOWED_ACTION_DESTINATIONS.includes(
				slide.actionUrl as (typeof ALLOWED_ACTION_DESTINATIONS)[number],
			),
	),
);
let unknownDestinationAllowed = $derived(
	unknownDestination && isAllowedActionDestination(slide.actionUrl),
);
let desktopDetails = $derived(
	slide.desktopAssetId ? assetDetails[slide.desktopAssetId] : undefined,
);
let mobileDetails = $derived(
	slide.mobileAssetId ? assetDetails[slide.mobileAssetId] : undefined,
);

function fails(field: string): boolean {
	return failures.has(`${field}:${locale}`);
}

function setLocalized(field: "title" | "body" | "alt" | "actionLabel", value: string) {
	const suffix = locale === "en" ? "En" : "Hu";
	const key = `${field === "alt" ? "alt" : field}${suffix}` as keyof EditorSlide;
	onUpdate({ [key]: value } as Partial<EditorSlide>);
}
</script>

<section class="slide-editor" aria-label={$t('admin.campaigns.slideEditorLabel', { number: slideNumber })}>
	<header class="slide-head">
		<h3 class="slide-title">{$t('admin.campaigns.slideNumber', { number: slideNumber })}</h3>
		<div class="locale-pills" role="group" aria-label={$t('admin.campaigns.previewLanguage')}>
			{#each ['en', 'hu'] as const as option (option)}
				<button
					type="button"
					class="locale-pill"
					class:locale-pill-active={locale === option}
					aria-pressed={locale === option}
					onclick={() => onLocaleChange(option)}
				>
					{option === 'en' ? 'EN' : 'HU'}
					{#if slideLocaleHasFailure(checklist, slide.localId, option)}
						<span class="locale-dot" aria-hidden="true"></span>
					{/if}
				</button>
			{/each}
		</div>
		<OverflowMenu
			label={$t('admin.campaigns.slideMenuLabel')}
			triggerLabel={$t('admin.campaigns.slideMenuTrigger', { number: slideNumber })}
			items={menuItems}
			attention={menuAttention}
			testId="campaign-slide-menu"
		/>
	</header>

	<div class="field-stack">
		<div class="field">
			<label class="field-label" for={`slide-title-${slide.localId}`}>
				{$t('admin.campaigns.slideTitle')}
			</label>
			<input
				id={`slide-title-${slide.localId}`}
				class="settings-input"
				value={title}
				disabled={!editable}
				oninput={(event) => setLocalized('title', event.currentTarget.value)}
			/>
			{#if fails('title')}
				<p class="field-error">
					<TriangleAlert size={12} strokeWidth={2.2} aria-hidden="true" />
					{$t('admin.campaigns.fieldError.title', { language: languageName })}
				</p>
			{/if}
		</div>

		<div class="field">
			<label class="field-label" for={`slide-body-${slide.localId}`}>
				{$t('admin.campaigns.slideBody')}
			</label>
			<textarea
				id={`slide-body-${slide.localId}`}
				class="settings-input body-input"
				value={body}
				disabled={!editable}
				oninput={(event) => setLocalized('body', event.currentTarget.value)}
			></textarea>
			<div class="field-foot">
				{#if fails('body')}
					<p class="field-error">
						<TriangleAlert size={12} strokeWidth={2.2} aria-hidden="true" />
						{$t('admin.campaigns.fieldError.body', { language: languageName })}
					</p>
				{/if}
				<span class="char-count" class:char-count-over={body.length > BODY_GUIDE_LENGTH}>
					{body.length} / {BODY_GUIDE_LENGTH}
				</span>
			</div>
		</div>

		<div class="field">
			<label class="field-label" for={`slide-alt-${slide.localId}`}>
				{$t('admin.campaigns.slideAlt')}
				<InfoTooltip text={$t('admin.campaigns.slideAltHelp')} size={13} />
			</label>
			<input
				id={`slide-alt-${slide.localId}`}
				class="settings-input"
				value={altText}
				disabled={!editable}
				oninput={(event) => setLocalized('alt', event.currentTarget.value)}
			/>
			{#if fails('alt')}
				<p class="field-error">
					<TriangleAlert size={12} strokeWidth={2.2} aria-hidden="true" />
					{$t('admin.campaigns.fieldError.alt', { language: languageName })}
				</p>
			{/if}
		</div>

		<div class="field">
			<span class="field-label">
				{$t('admin.campaigns.slideAction')}
				<InfoTooltip text={$t('admin.campaigns.slideActionHelp')} size={13} />
			</span>
			<div class="action-grid">
				<div>
					<select
						class="settings-input"
						aria-label={$t('admin.campaigns.actionDestination')}
						value={slide.actionUrl ?? ''}
						disabled={!editable}
						onchange={(event) => onUpdate({ actionUrl: event.currentTarget.value })}
					>
						<option value="">{$t('admin.campaigns.destination.none')}</option>
						{#each ALLOWED_ACTION_DESTINATIONS as destination (destination)}
							<option value={destination}>
								{destination} — {$t(DESTINATION_LABELS[destination] as I18nKey)}
							</option>
						{/each}
						{#if unknownDestination}
							<option value={slide.actionUrl}>
								{slide.actionUrl}{unknownDestinationAllowed
									? ''
									: ` — ${$t('admin.campaigns.destination.notAllowed')}`}
							</option>
						{/if}
					</select>
					{#if failures.has('actionDestination')}
						<p class="field-error">
							<TriangleAlert size={12} strokeWidth={2.2} aria-hidden="true" />
							{$t('admin.campaigns.validation.actionDestinationInvalid')}
						</p>
					{/if}
				</div>
				<div>
					<input
						class="settings-input"
						aria-label={$t('admin.campaigns.actionLabel')}
						placeholder={$t('admin.campaigns.actionLabelPlaceholder')}
						value={actionLabel}
						disabled={!editable}
						oninput={(event) => setLocalized('actionLabel', event.currentTarget.value)}
					/>
					{#if fails('actionLabel')}
						<p class="field-error">
							<TriangleAlert size={12} strokeWidth={2.2} aria-hidden="true" />
							{$t('admin.campaigns.fieldError.actionLabel', { language: languageName })}
						</p>
					{/if}
				</div>
			</div>
		</div>
	</div>

	<div class="asset-grid">
		<SlideAssetBlock
			variant="desktop"
			assetId={slide.desktopAssetId}
			sourceAssetId={slide.desktopSourceAssetId ?? desktopDetails?.sourceAssetId ?? null}
			filename={desktopDetails?.filename ?? ''}
			sizeBytes={desktopDetails?.sizeBytes ?? 0}
			uploading={uploadingVariant === 'desktop'}
			{editable}
			onUpload={(file) => onAssetUpload('desktop', file)}
			onRecrop={() => onAssetRecrop('desktop')}
			onRemove={() => onAssetRemove('desktop')}
		/>
		<SlideAssetBlock
			variant="mobile"
			assetId={slide.mobileAssetId}
			sourceAssetId={slide.mobileSourceAssetId ?? mobileDetails?.sourceAssetId ?? null}
			filename={mobileDetails?.filename ?? ''}
			sizeBytes={mobileDetails?.sizeBytes ?? 0}
			uploading={uploadingVariant === 'mobile'}
			{editable}
			onUpload={(file) => onAssetUpload('mobile', file)}
			onRecrop={() => onAssetRecrop('mobile')}
			onRemove={() => onAssetRemove('mobile')}
		/>
	</div>
</section>

<style>
	.slide-editor {
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		background: var(--surface-overlay);
		padding: 1rem 1.125rem;
	}

	.slide-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.875rem;
	}

	.slide-title {
		flex: 1 1 auto;
		min-width: 0;
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.locale-pills {
		display: inline-flex;
		gap: 0.25rem;
	}

	.locale-pill {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		height: 26px;
		padding: 0 0.5rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background: var(--surface-page);
		color: var(--text-muted);
		font-size: var(--text-2xs);
		cursor: pointer;
		transition:
			border-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	.locale-pill:hover {
		color: var(--text-primary);
	}

	.locale-pill-active {
		color: var(--accent);
		border-color: color-mix(in srgb, var(--accent) 40%, transparent);
	}

	.locale-pill:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.locale-dot {
		width: 6px;
		height: 6px;
		border-radius: var(--radius-full);
		background: var(--danger);
	}

	.field-stack {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
	}

	.field-label {
		display: flex;
		align-items: center;
		gap: 0.15rem;
		margin-bottom: 0.3rem;
		font-size: 0.82rem;
		font-weight: 500;
		color: var(--text-primary);
	}

	.body-input {
		min-height: 4.5rem;
		line-height: 1.55;
	}

	/* A published campaign is read-only; the greying is the second cue after
	   the banner above the editor. */
	.settings-input:disabled {
		opacity: 0.72;
		cursor: not-allowed;
	}

	.field-foot {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.2rem;
	}

	.char-count {
		margin-left: auto;
		font-size: 0.66rem;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.char-count-over {
		color: var(--warning);
	}

	.field-error {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		margin-top: 0.3rem;
		font-size: var(--text-2xs);
		color: var(--danger);
	}

	.field-foot .field-error {
		margin-top: 0;
	}

	.action-grid {
		display: grid;
		gap: 0.625rem;
		grid-template-columns: minmax(0, 1fr);
	}

	.asset-grid {
		display: grid;
		gap: 0.75rem;
		grid-template-columns: minmax(0, 1fr);
		margin-top: 0.875rem;
	}

	@media (min-width: 720px) {
		.action-grid,
		.asset-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
</style>
