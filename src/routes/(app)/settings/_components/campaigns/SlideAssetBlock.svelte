<script lang="ts">
import { Crop, Image as ImageIcon } from "@lucide/svelte";
import InfoTooltip from "$lib/components/ui/InfoTooltip.svelte";
import type { CampaignAssetVariant } from "$lib/client/api/campaign-assets";
import { t } from "$lib/i18n";

let {
	variant,
	assetId = null,
	sourceAssetId = null,
	filename = "",
	sizeBytes = 0,
	uploading = false,
	editable = true,
	onUpload,
	onRecrop,
	onRemove,
}: {
	variant: CampaignAssetVariant;
	assetId?: string | null;
	sourceAssetId?: string | null;
	filename?: string;
	sizeBytes?: number;
	uploading?: boolean;
	editable?: boolean;
	onUpload: (file: File) => void;
	onRecrop: () => void;
	onRemove: () => void;
} = $props();

const inputSuffix = Math.random().toString(36).slice(2, 8);
let inputId = $derived(`slide-asset-${variant}-${inputSuffix}`);

let previewUrl = $derived(
	assetId
		? `/api/campaign-assets/${encodeURIComponent(assetId)}/content`
		: null,
);

function formatSize(bytes: number): string {
	if (!bytes || bytes <= 0) return "";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function handleFile(event: Event) {
	const input = event.currentTarget as HTMLInputElement;
	const file = input.files?.[0];
	input.value = "";
	if (file) onUpload(file);
}
</script>

<div class="asset-block" class:asset-block-empty={!assetId} data-testid={`campaign-asset-${variant}`}>
	<div class="asset-head">
		<span class="asset-thumb" class:asset-thumb-mobile={variant === 'mobile'}>
			{#if previewUrl}
				<img src={previewUrl} alt="" loading="lazy" />
			{:else}
				<span class="asset-thumb-empty">
					<ImageIcon size={variant === 'mobile' ? 15 : 18} strokeWidth={1.8} aria-hidden="true" />
				</span>
			{/if}
		</span>
		<span class="asset-copy">
			<span class="asset-label">
				{variant === 'desktop'
					? $t('admin.campaigns.desktopAsset')
					: $t('admin.campaigns.mobileAsset')}
			</span>
			{#if assetId}
				<span class="asset-meta">
					{filename || $t('admin.campaigns.assetAttachedShort')}
					{#if sizeBytes > 0}
						· {formatSize(sizeBytes)}
					{/if}
				</span>
			{:else if variant === 'mobile'}
				<span class="asset-note">
					{$t('admin.campaigns.mobileFallsBack')}
					<InfoTooltip text={$t('admin.campaigns.mobileFallsBackHelp')} size={13} />
				</span>
			{:else}
				<span class="asset-note">{$t('admin.campaigns.assetMissing')}</span>
			{/if}
		</span>
	</div>

	<div class="asset-actions">
		{#if assetId}
			<label class="mini-btn" class:mini-btn-disabled={!editable}>
				{$t('admin.campaigns.assetReplace')}
				<input
					id={inputId}
					class="sr-only"
					type="file"
					accept="image/*"
					disabled={!editable}
					onchange={handleFile}
				/>
			</label>
			<button
				type="button"
				class="mini-btn"
				disabled={!editable || !sourceAssetId}
				title={sourceAssetId ? undefined : $t('admin.campaigns.assetRecropUnavailable')}
				onclick={onRecrop}
			>
				<Crop size={11} strokeWidth={2} aria-hidden="true" />
				{$t('admin.campaigns.assetRecrop')}
			</button>
			<button type="button" class="mini-btn mini-btn-danger" disabled={!editable} onclick={onRemove}>
				{$t('admin.campaigns.assetRemove')}
			</button>
		{:else}
			<label class="mini-btn" class:mini-btn-disabled={!editable}>
				{$t('admin.campaigns.assetAdd')}
				<input
					id={inputId}
					class="sr-only"
					type="file"
					accept="image/*"
					disabled={!editable}
					onchange={handleFile}
				/>
			</label>
		{/if}
		{#if uploading}
			<span class="asset-uploading">{$t('admin.campaigns.uploadingAsset')}</span>
		{/if}
	</div>
</div>

<style>
	.asset-block {
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-page);
		padding: 0.625rem;
	}

	.asset-block-empty {
		border-style: dashed;
	}

	.asset-head {
		display: flex;
		align-items: flex-start;
		gap: 0.625rem;
	}

	.asset-thumb {
		flex: 0 0 84px;
		width: 84px;
		aspect-ratio: 16 / 10;
		overflow: hidden;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background: var(--surface-elevated);
	}

	.asset-thumb-mobile {
		flex-basis: 48px;
		width: 48px;
		aspect-ratio: 9 / 16;
	}

	.asset-block-empty .asset-thumb {
		border-style: dashed;
		background: transparent;
	}

	.asset-thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}

	.asset-thumb-empty {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		height: 100%;
		color: var(--text-muted);
	}

	.asset-copy {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
	}

	.asset-label {
		font-size: var(--text-2xs);
		font-weight: 500;
		color: var(--text-primary);
	}

	.asset-meta {
		font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.68rem;
		line-height: 1.4;
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}

	.asset-note {
		display: inline-flex;
		align-items: center;
		gap: 0.15rem;
		font-size: var(--text-2xs);
		color: var(--text-muted);
	}

	.asset-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.375rem;
		margin-top: 0.55rem;
	}

	.mini-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		height: 26px;
		padding: 0 0.5rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border-default);
		background: var(--surface-page);
		color: var(--text-secondary);
		font-size: var(--text-2xs);
		white-space: nowrap;
		cursor: pointer;
		transition:
			border-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	.mini-btn:hover:not(:disabled):not(.mini-btn-disabled) {
		border-color: color-mix(in srgb, var(--accent) 45%, transparent);
		color: var(--accent);
	}

	.mini-btn:focus-visible,
	.mini-btn:focus-within {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.mini-btn:disabled,
	.mini-btn-disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.mini-btn-danger {
		color: var(--danger);
		border-color: color-mix(in srgb, var(--danger) 32%, transparent);
	}

	.mini-btn-danger:hover:not(:disabled) {
		border-color: var(--danger);
		color: var(--danger);
	}

	.asset-uploading {
		font-size: var(--text-2xs);
		color: var(--text-muted);
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border-width: 0;
	}
</style>
