<script lang="ts">
// The panel's strip of an Image's versions (plan 2b T3, design 5.6): one
// thumbnail per version, oldest first, read from History's image moments, so the
// strip and History never disagree about what the versions are. Each frame is
// named in History's own words (`moment-text.ts`: "Your photo", "You picked
// another take", when it was), never a version number (ruling 76). Choosing a
// frame opens History on that version (F11).
//
// The row is always there, with or without frames, so a second version landing
// while the panel is open (F23) fills it instead of pushing the picture up. The
// thumbnails sit in reserved square tiles and fade in on load (`ImagePicture`).
import { t } from "$lib/i18n";
import type { ArtifactMoment } from "$lib/shared/artifacts/history";
import { IMAGE_THUMB_LONG_EDGE } from "$lib/shared/artifacts/image-body";
import { uiLanguage } from "$lib/stores/settings";
import { entryHeadline, whenLabel } from "../history/moment-text";
import { momentEntry } from "../history/rail-model";
import ImagePicture from "./ImagePicture.svelte";

let {
	moments,
	currentVersionId = null,
	conversationId = null,
	onOpenHistory = undefined,
}: {
	/** History's moments, newest first, as the route answers them. */
	moments: readonly ArtifactMoment[];
	/** The version the panel shows; by default the moment that holds the newest. */
	currentVersionId?: string | null;
	conversationId?: string | null;
	onOpenHistory?: ((versionId: string) => void) | undefined;
} = $props();

function capitalize(text: string): string {
	return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

let ctx = $derived({
	t: $t,
	lang: ($uiLanguage === "hu" ? "hu" : "en") as "en" | "hu",
	now: Date.now(),
});

let frames = $derived(
	moments
		.flatMap((moment) =>
			moment.detail.type === "image"
				? [
						{
							versionId: moment.versionId,
							fileId: moment.detail.fileId,
							current:
								currentVersionId !== null
									? moment.versionId === currentVersionId
									: moment.containsNewest,
							label: `${capitalize(whenLabel(moment.at, ctx))} · ${entryHeadline(momentEntry(moment), ctx, "image")}`,
						},
					]
				: [],
		)
		.reverse(),
);
</script>

<div class="strip" role="group" aria-label={$t('artifacts.image.panel.versions')} data-testid="image-version-strip">
	{#if frames.length > 1}
		{#each frames as frame (frame.versionId)}
			<button
				type="button"
				class="frame"
				class:is-current={frame.current}
				aria-current={frame.current ? 'true' : undefined}
				aria-label={frame.label}
				title={frame.label}
				data-testid="image-version-frame"
				data-version-id={frame.versionId}
				onclick={() => onOpenHistory?.(frame.versionId)}
			>
				<ImagePicture
					fileId={frame.fileId}
					width={IMAGE_THUMB_LONG_EDGE}
					height={IMAGE_THUMB_LONG_EDGE}
					alt=""
					{conversationId}
					variant="thumb"
				/>
			</button>
		{/each}
	{/if}
</div>

<style>
	/* One row, its height reserved whatever it holds; many frames scroll inside it. */
	.strip {
		display: flex;
		gap: 0.375rem;
		height: 3.5rem;
		min-height: 3.5rem;
		overflow-x: auto;
		overflow-y: hidden;
		scrollbar-width: none;
		overscroll-behavior-x: contain;
	}

	.strip::-webkit-scrollbar {
		display: none;
	}

	.frame {
		position: relative;
		flex: none;
		width: 3.5rem;
		height: 3.5rem;
		padding: 0;
		overflow: hidden;
		border: 0;
		border-radius: var(--radius-sm);
		background: var(--surface-elevated);
		box-shadow: 0 0 0 1px var(--border-default);
		cursor: pointer;
		opacity: 0.82;
		transition: opacity var(--duration-standard) var(--ease-out);
	}

	.frame:hover,
	.frame.is-current {
		opacity: 1;
	}

	/* The shown version's ring fades in and out (opacity only). */
	.frame::after {
		content: "";
		position: absolute;
		inset: 0;
		border-radius: inherit;
		box-shadow: inset 0 0 0 2px var(--accent);
		opacity: 0;
		pointer-events: none;
		transition: opacity var(--duration-standard) var(--ease-out);
	}

	.frame.is-current::after {
		opacity: 1;
	}

	.frame:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.frame :global(.image-picture) {
		height: 100%;
	}

	.frame :global(.image-picture-img) {
		object-fit: cover;
	}
</style>
