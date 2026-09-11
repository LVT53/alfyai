<script lang="ts">
// Everyday redesign — the attachment picker, on a phone only.
//
// There is no attachment dialog in the app today: Attach file clicks a hidden
// file input and the operating system takes over. On a desktop that is the
// right answer and this component is never shown — a sheet that offers one
// row saying "open the file picker" is a speed bump.
//
// On a phone it adds three real choices the OS hand-off cannot: photos
// (accept=image/*), the camera (capture), and the document Library, which is
// the only row that opens something of ours and so the only one with a
// chevron. The Library route exists already — it is what "/link" opens — but
// it was reachable only by typing a slash command, which is exactly the kind
// of thing a phone keyboard makes expensive.
//
// Every row IS the action, so this sheet has no positive button; it ends in
// one full-width Cancel.
import { Camera, ChevronRight, File, Folder, Image } from "@lucide/svelte";
import DialogShell from "$lib/components/ui/DialogShell.svelte";
import { t } from "$lib/i18n";

let {
	maxUploadMb = 100,
	onFiles,
	onOpenLibrary,
	onCancel,
}: {
	maxUploadMb?: number;
	onFiles: (files: FileList | null) => void;
	onOpenLibrary: () => void;
	onCancel: () => void;
} = $props();

let photoInput = $state<HTMLInputElement | null>(null);
let cameraInput = $state<HTMLInputElement | null>(null);
let fileInput = $state<HTMLInputElement | null>(null);

function handlePicked(event: Event) {
	const input = event.currentTarget as HTMLInputElement;
	const files = input.files;
	// Cancelling the OS picker fires no change event at all, so reaching here
	// with nothing selected means an empty pick — close either way, but only
	// hand files on when there are some.
	if (files && files.length > 0) onFiles(files);
	input.value = "";
	onCancel();
}
</script>

{#snippet footer()}
	<button
		type="button"
		class="btn-secondary attachment-sheet__cancel"
		data-testid="attachment-picker-cancel"
		onclick={onCancel}
	>
		{$t('attachmentPicker.cancel')}
	</button>
{/snippet}

<DialogShell
	title={$t('attachmentPicker.title')}
	onClose={onCancel}
	maxWidthClass="max-w-[26rem]"
	phonePresentation="sheet"
	titleVisuallyHidden
	{footer}
>
	<div class="attachment-sheet" data-testid="attachment-picker">
		<header class="attachment-sheet__head">
			<h3 class="attachment-sheet__title">{$t('attachmentPicker.title')}</h3>
			<p class="attachment-sheet__subtitle">
				{$t('attachmentPicker.subtitle', { max: maxUploadMb })}
			</p>
		</header>

		<input
			bind:this={photoInput}
			type="file"
			class="hidden"
			accept="image/*"
			multiple
			onchange={handlePicked}
		/>
		<input
			bind:this={cameraInput}
			type="file"
			class="hidden"
			accept="image/*"
			capture="environment"
			onchange={handlePicked}
		/>
		<input
			bind:this={fileInput}
			type="file"
			class="hidden"
			multiple
			onchange={handlePicked}
		/>

		<ul class="attachment-sheet__list">
			<li>
				<button
					type="button"
					class="attachment-sheet__row"
					data-testid="attachment-picker-photos"
					onclick={() => photoInput?.click()}
				>
					<span class="attachment-sheet__icon" aria-hidden="true"><Image size={16} strokeWidth={2} /></span>
					<span class="attachment-sheet__copy">
						<span class="attachment-sheet__name">{$t('attachmentPicker.photoLibrary')}</span>
						<span class="attachment-sheet__hint">{$t('attachmentPicker.photoLibraryHint')}</span>
					</span>
				</button>
			</li>
			<li>
				<button
					type="button"
					class="attachment-sheet__row"
					data-testid="attachment-picker-camera"
					onclick={() => cameraInput?.click()}
				>
					<span class="attachment-sheet__icon" aria-hidden="true"><Camera size={16} strokeWidth={2} /></span>
					<span class="attachment-sheet__copy">
						<span class="attachment-sheet__name">{$t('attachmentPicker.camera')}</span>
						<span class="attachment-sheet__hint">{$t('attachmentPicker.cameraHint')}</span>
					</span>
				</button>
			</li>
			<li>
				<button
					type="button"
					class="attachment-sheet__row"
					data-testid="attachment-picker-files"
					onclick={() => fileInput?.click()}
				>
					<span class="attachment-sheet__icon" aria-hidden="true"><Folder size={16} strokeWidth={2} /></span>
					<span class="attachment-sheet__copy">
						<span class="attachment-sheet__name">{$t('attachmentPicker.files')}</span>
						<span class="attachment-sheet__hint">{$t('attachmentPicker.filesHint')}</span>
					</span>
				</button>
			</li>
			<li>
				<button
					type="button"
					class="attachment-sheet__row"
					data-testid="attachment-picker-library"
					onclick={onOpenLibrary}
				>
					<span class="attachment-sheet__icon" aria-hidden="true"><File size={16} strokeWidth={2} /></span>
					<span class="attachment-sheet__copy">
						<span class="attachment-sheet__name">{$t('attachmentPicker.library')}</span>
						<span class="attachment-sheet__hint">{$t('attachmentPicker.libraryHint')}</span>
					</span>
					<!-- The one row that opens something of ours, and so the only
					     one that earns a chevron. -->
					<span class="attachment-sheet__chevron" aria-hidden="true"><ChevronRight size={15} strokeWidth={2} /></span>
				</button>
			</li>
		</ul>
	</div>
</DialogShell>

<style>
	.attachment-sheet {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		font-family: var(--font-sans);
	}

	.attachment-sheet__head {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}

	.attachment-sheet__title {
		margin: 0;
		font-size: var(--text-lg);
		font-weight: 700;
		line-height: 1.2;
		color: var(--text-primary);
	}

	.attachment-sheet__subtitle {
		margin: 0;
		font-size: var(--text-xs);
		color: var(--text-muted);
	}

	.attachment-sheet__list {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.attachment-sheet__row {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		width: 100%;
		min-height: 44px;
		border: 0;
		border-top: 1px solid var(--border-subtle);
		background: transparent;
		padding: 0.55rem 0.15rem;
		text-align: left;
		cursor: pointer;
		transition: background-color var(--duration-standard) var(--ease-out);
	}

	.attachment-sheet__list li:first-child .attachment-sheet__row {
		border-top: 0;
	}

	.attachment-sheet__row:hover,
	.attachment-sheet__row:focus-visible {
		background: color-mix(in srgb, var(--accent) 10%, transparent);
		outline: none;
	}

	.attachment-sheet__row:focus-visible {
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 40%, transparent 60%);
	}

	.attachment-sheet__icon {
		display: inline-flex;
		flex: 0 0 auto;
		color: var(--text-secondary);
	}

	.attachment-sheet__row:hover .attachment-sheet__icon,
	.attachment-sheet__row:focus-visible .attachment-sheet__icon {
		color: var(--accent);
	}

	.attachment-sheet__copy {
		display: flex;
		flex: 1;
		min-width: 0;
		flex-direction: column;
		gap: 0.08rem;
	}

	.attachment-sheet__name {
		font-size: var(--text-sm);
		font-weight: 600;
		line-height: 1.2;
		color: var(--text-primary);
	}

	.attachment-sheet__hint {
		font-size: var(--text-xs);
		line-height: 1.3;
		color: var(--text-muted);
	}

	.attachment-sheet__chevron {
		display: inline-flex;
		flex: 0 0 auto;
		color: var(--text-muted);
	}

	.attachment-sheet__cancel {
		min-height: 44px;
	}

	.hidden {
		display: none;
	}

	@media (prefers-reduced-motion: reduce) {
		.attachment-sheet__row {
			transition: none;
		}
	}
</style>
