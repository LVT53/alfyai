<script lang="ts">
// One attached photo, full size, with the Mark tool, for a composer with no
// document panel: the landing page, where the chat does not exist yet. The
// boxes stay with the page that hosts the composer until the first message
// carries them over.
import X from "@lucide/svelte/icons/x";
import UploadPictureMarks from "$lib/components/artifacts/image/UploadPictureMarks.svelte";
import { t } from "$lib/i18n";
import type { ImageMark } from "$lib/shared/artifacts/image-body";
import { focusTrap } from "$lib/utils/focus-trap";
import { portalToBody } from "$lib/utils/portal";

let {
	artifactId,
	name,
	marks,
	onChange,
	onClose,
}: {
	artifactId: string;
	name: string;
	marks: ImageMark[];
	onChange: (marks: ImageMark[]) => void;
	onClose: () => void;
} = $props();

let url = $derived(`/api/knowledge/${encodeURIComponent(artifactId)}/preview`);
const trap = focusTrap({ onEscape: () => onClose() });
</script>

<div class="photo-mark-dialog" role="dialog" aria-modal="true" aria-label={name} use:portalToBody {@attach trap} data-testid="photo-mark-dialog">
	<header class="photo-mark-dialog__head">
		<span>{name}</span>
		<button type="button" aria-label={$t('common.close')} onclick={onClose} data-testid="photo-mark-dialog-close">
			<X size={18} strokeWidth={2} aria-hidden="true" />
		</button>
	</header>
	<div class="photo-mark-dialog__body">
		<UploadPictureMarks {url} filename={name} {marks} {onChange} onContinue={onClose} covering startMarking>
			{#snippet preview()}
				<img class="photo-mark-dialog__preview" src={url} alt={name} />
			{/snippet}
		</UploadPictureMarks>
	</div>
</div>

<style>
	.photo-mark-dialog {
		position: fixed;
		inset: 0;
		z-index: 60;
		display: flex;
		flex-direction: column;
		background: var(--surface-page);
	}

	.photo-mark-dialog__head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-sm);
		flex: 0 0 auto;
		padding: var(--space-sm) var(--space-md);
		padding-top: max(var(--space-sm), env(safe-area-inset-top, 0px));
		border-bottom: 1px solid var(--border-default);
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: 0.9375rem;
		font-weight: 600;
	}

	.photo-mark-dialog__head span {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.photo-mark-dialog__head button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 44px;
		height: 44px;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--text-primary);
		cursor: pointer;
	}

	.photo-mark-dialog__head button:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.photo-mark-dialog__body {
		flex: 1 1 auto;
		min-height: 0;
		padding-bottom: env(safe-area-inset-bottom, 0px);
	}

	.photo-mark-dialog__preview {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: contain;
	}
</style>
