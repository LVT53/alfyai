<script lang="ts">
/**
 * The admin's preview of a tour: the reader's own card, drawn with the draft's
 * words, instead of the announcement modal (a logo, a title, a body and
 * "1 / 4") that a tour is not. The summary slide is the line an empty item
 * shows, so it previews as that: the shared empty state, the line and the
 * "Show it again" link beneath it.
 *
 * It is a picture, not a second copy of the card: the card is loaded lazily
 * from `artifacts/tour/` (the settings route does not carry it until a tour is
 * open) and the wrapper is `inert`, so the card's focus-taking, Escape and
 * buttons never reach the admin and nothing is recorded. The slide shown is the
 * one open in the rail.
 *
 * The card picks its language from the interface; the draft is edited in EN or
 * HU, so each text is handed over in the language being edited, in both
 * fields, and the card shows exactly that.
 */
import { onMount } from "svelte";
import type ArtifactTour from "$lib/components/artifacts/tour/ArtifactTour.svelte";
import EmptyState from "$lib/components/artifacts/EmptyState.svelte";
import { t } from "$lib/i18n";
import {
	isShippedArtifactTourType,
	type LocalizedText,
	type ResolvedArtifactTour,
} from "$lib/shared/artifacts/tours";

type PreviewSlide = {
	kind: string;
	titleEn?: string | null;
	titleHu?: string | null;
	bodyEn?: string | null;
	bodyHu?: string | null;
};

let {
	releaseVersion,
	slides,
	locale,
	slideIndex,
}: {
	/** The campaign's release text, which for a tour names its kind. */
	releaseVersion: string | null | undefined;
	slides: PreviewSlide[];
	locale: "en" | "hu";
	/** The slide open in the rail. */
	slideIndex: number;
} = $props();

let Card = $state<typeof ArtifactTour | null>(null);

onMount(() => {
	void import("$lib/components/artifacts/tour/ArtifactTour.svelte").then(
		(module) => {
			Card = module.default;
		},
	);
});

/** The text in the language being edited, in both fields: the card reads whichever one the interface speaks. */
function said(en: string | null | undefined, hu: string | null | undefined) {
	const text = (locale === "en" ? en : hu) ?? "";
	return { en: text, hu: text } satisfies LocalizedText;
}

let kind = $derived.by(() => {
	const text = releaseVersion?.trim() ?? "";
	return isShippedArtifactTourType(text) ? text : null;
});
let steps = $derived(slides.filter((slide) => slide.kind !== "summary"));
let summary = $derived(slides.find((slide) => slide.kind === "summary"));
let open = $derived(slides[slideIndex] ?? null);
/** Which step the open slide is, or -1 for the summary slide (the empty-state line). */
let stepIndex = $derived(
	open && open.kind !== "summary"
		? slides.slice(0, slideIndex).filter((slide) => slide.kind !== "summary")
				.length
		: -1,
);
let tour = $derived<ResolvedArtifactTour | null>(
	kind
		? {
				artifactType: kind,
				contentKey: "preview",
				source: "published",
				slides: steps.map((slide) => ({
					title: said(slide.titleEn, slide.titleHu),
					body: said(slide.bodyEn, slide.bodyHu),
				})),
				summary: said(summary?.titleEn, summary?.titleHu),
			}
		: null,
);

function nothing() {}
</script>

<div class="tour-preview" data-testid="tour-preview" inert>
	{#if !tour}
		<p class="tour-preview-note">{$t('admin.campaigns.tour.previewNoKind')}</p>
	{:else if stepIndex < 0}
		<div class="tour-preview-empty" data-testid="tour-preview-empty">
			<EmptyState
				line={tour.summary[locale]}
				testId="tour-preview-line"
				onReplayTour={nothing}
			/>
		</div>
	{:else if Card}
		<!-- Keyed on the step so choosing another slide in the rail shows that one; typing
		     changes `tour`, which the card follows without being rebuilt. -->
		{#key stepIndex}
			<Card {tour} startSlide={stepIndex} onSeen={nothing} onDismiss={nothing} />
		{/key}
	{/if}
</div>

<style>
	.tour-preview {
		min-width: 0;
		padding-bottom: 0.75rem;
	}

	.tour-preview-note {
		margin: 0;
		padding: 1rem;
		font-size: var(--text-2xs);
		line-height: 1.5;
		color: var(--text-muted);
	}

	/* What an empty item looks like: a page with one quiet line in it. */
	.tour-preview-empty {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 9rem;
		margin: 0.75rem 1rem 0;
		padding: 1.5rem 1rem;
		text-align: center;
		border: 1px dashed var(--border-default);
		border-radius: var(--radius-lg);
		background: var(--surface-page);
	}
</style>
