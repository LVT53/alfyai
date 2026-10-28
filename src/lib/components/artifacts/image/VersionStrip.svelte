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
import { Paperclip } from "@lucide/svelte";
import { tick } from "svelte";
import { t } from "$lib/i18n";
import { oneLineName } from "$lib/shared/one-line-name";
import type { ArtifactMoment } from "$lib/shared/artifacts/history";
import { IMAGE_THUMB_LONG_EDGE } from "$lib/shared/artifacts/image-body";
import { uiLanguage } from "$lib/stores/settings";
import { prefersReducedMotion } from "$lib/utils/motion";
import { entryHeadline, whenLabel } from "../history/moment-text";
import { momentEntry } from "../history/rail-model";
import ImagePicture from "./ImagePicture.svelte";
import "./picture-tile.css";
import { overflowEdges, scrollLeftToShow } from "./strip-scroll";

let {
	moments,
	currentVersionId = null,
	conversationId = null,
	title = "",
	onOpenHistory = undefined,
	onAttachPicture = undefined,
}: {
	/** History's moments, newest first, as the route answers them. */
	moments: readonly ArtifactMoment[];
	/** The version the panel shows; by default the moment that holds the newest. */
	currentVersionId?: string | null;
	conversationId?: string | null;
	/** The item's name: an attached frame is named after it. */
	title?: string;
	onOpenHistory?: ((versionId: string) => void) | undefined;
	/** Puts a frame's own picture in the composer (plan 2b T5). Absent where the host has none. */
	onAttachPicture?:
		| ((picture: { imageFileId: string; name: string; at?: number }) => void)
		| undefined;
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
							at: moment.at,
							label: `${capitalize(whenLabel(moment.at, ctx))} · ${entryHeadline(momentEntry(moment), ctx, "image")}`,
						},
					]
				: [],
		)
		.reverse(),
);

// A narrow row (a phone) shows two or three frames: the current one (oldest
// first, so usually the last) is scrolled whole into view, at once on the
// first paint and under reduced motion, smoothly after; and a side that
// hides frames wears a fade, as the composer's chip rail does (B-I5).
let stripEl = $state<HTMLDivElement | null>(null);
let edges = $state({ start: false, end: false });
let placedOnce = false;

function measureEdges(): void {
	if (!stripEl) return;
	const next = overflowEdges(stripEl);
	if (next.start !== edges.start || next.end !== edges.end) edges = next;
}

function showCurrentFrame(strip: HTMLDivElement, versionId: string): void {
	const frame = [
		...strip.querySelectorAll<HTMLElement>('[data-testid="image-version-frame"]'),
	].find((element) => element.dataset.versionId === versionId);
	if (!frame) return;
	const stripRect = strip.getBoundingClientRect();
	const rect = frame.getBoundingClientRect();
	const left = scrollLeftToShow(
		{ left: rect.left - stripRect.left + strip.scrollLeft, width: rect.width },
		strip,
	);
	if (Math.abs(left - strip.scrollLeft) <= 0.5) return;
	const smooth = placedOnce && !prefersReducedMotion();
	if (typeof strip.scrollTo === "function") {
		strip.scrollTo({ left, behavior: smooth ? "smooth" : "auto" });
	} else {
		strip.scrollLeft = left;
	}
}

$effect(() => {
	const strip = stripEl;
	const current = frames.find((frame) => frame.current)?.versionId ?? null;
	const count = frames.length;
	if (!strip) return;
	void tick().then(() => {
		if (current && count > 1) showCurrentFrame(strip, current);
		placedOnce = true;
		measureEdges();
	});
});

$effect(() => {
	const strip = stripEl;
	if (!strip) return;
	const onScroll = () => measureEdges();
	strip.addEventListener("scroll", onScroll, { passive: true });
	const observer =
		typeof ResizeObserver === "undefined"
			? null
			: new ResizeObserver(() => measureEdges());
	observer?.observe(strip);
	return () => {
		strip.removeEventListener("scroll", onScroll);
		observer?.disconnect();
	};
});
</script>

<div
	bind:this={stripEl}
	class="strip"
	class:fade-start={edges.start}
	class:fade-end={edges.end}
	role="group" aria-label={$t('artifacts.image.panel.versions')} data-testid="image-version-strip">
	{#if frames.length > 1}
		{#each frames as frame (frame.versionId)}
			<div class="cell">
				<button
					type="button"
					class="frame picture-tile"
					class:is-chosen={frame.current}
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
				{#if onAttachPicture}
					<button
						type="button"
						class="attach"
						aria-label={$t('artifacts.image.attachNamed', { name: frame.label })}
						title={$t('artifacts.image.card.attach')}
						data-testid="image-version-attach"
						onclick={() => onAttachPicture?.({ imageFileId: frame.fileId, name: oneLineName(title), at: frame.at })}
					>
						<Paperclip size={12} strokeWidth={2} aria-hidden="true" />
					</button>
				{/if}
			</div>
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

	/* A side that hides frames fades out, so a cut frame reads as "more this
	   way". Not animated: the mask follows the scroll. */
	.strip.fade-end {
		mask-image: linear-gradient(90deg, #000 calc(100% - 1.5rem), transparent);
		-webkit-mask-image: linear-gradient(
			90deg,
			#000 calc(100% - 1.5rem),
			transparent
		);
	}

	.strip.fade-start {
		mask-image: linear-gradient(90deg, transparent, #000 1.5rem);
		-webkit-mask-image: linear-gradient(90deg, transparent, #000 1.5rem);
	}

	.strip.fade-start.fade-end {
		mask-image: linear-gradient(
			90deg,
			transparent,
			#000 1.5rem,
			#000 calc(100% - 1.5rem),
			transparent
		);
		-webkit-mask-image: linear-gradient(
			90deg,
			transparent,
			#000 1.5rem,
			#000 calc(100% - 1.5rem),
			transparent
		);
	}

	/* The tile's look is the shared picture tile (picture-tile.css); a frame is square. */
	.cell {
		position: relative;
		flex: none;
		width: 3.5rem;
		height: 3.5rem;
	}

	.frame {
		width: 100%;
		height: 100%;
	}

	/* Attach rides the frame's corner: a small scrimmed dot for a mouse. A finger
	   cannot hit a dot this size without hitting the frame under it, and a frame
	   is 56 px, so on touch the dot is not drawn: a frame opens History on its
	   version, where Attach is a 44 px button (ImageVersionPreview). Only opacity
	   moves. */
	.attach {
		position: absolute;
		right: 0.125rem;
		bottom: 0.125rem;
		display: grid;
		place-items: center;
		width: 1.5rem;
		height: 1.5rem;
		padding: 0;
		border: 0;
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--surface-page) 82%, transparent);
		box-shadow: 0 0 0 1px var(--border-default);
		color: var(--text-primary);
		cursor: pointer;
		opacity: 0.9;
		transition: opacity var(--duration-standard) var(--ease-out);
	}

	@media (pointer: coarse) {
		.attach {
			display: none;
		}
	}

	.attach:hover {
		opacity: 1;
	}

	.attach:focus-visible {
		outline: none;
		opacity: 1;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.frame:hover {
		opacity: 1;
	}
</style>
