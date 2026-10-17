<script lang="ts">
/**
 * The admin's preview of a feature note: the reader's own strip, drawn with the
 * draft's words, instead of the announcement modal a note is not. The note's
 * one slide is the existing `standard`/`feature` slide the server seeds.
 *
 * It is a picture, not a second copy of the card: the wrapper is `inert`, so
 * the strip's dismiss and action never reach the admin and nothing is recorded.
 * The strip picks its language from its prop; the draft is edited in EN or HU,
 * so the card shows exactly the language being edited (the strip falls back to
 * the other one only while a draft is still empty).
 */
import FeatureNoteStrip from "$lib/components/campaigns/FeatureNoteStrip.svelte";
import type { FeatureNote } from "$lib/client/api/campaigns";
import type { ChecklistLocale } from "./campaign-checklist";

type PreviewSlide = {
	titleEn?: string | null;
	titleHu?: string | null;
	bodyEn?: string | null;
	bodyHu?: string | null;
	actionLabelEn?: string | null;
	actionLabelHu?: string | null;
	actionUrl?: string | null;
};

let {
	name,
	slides,
	locale,
}: {
	name: string;
	slides: PreviewSlide[];
	/** The language the admin is editing, so the preview speaks it. */
	locale: ChecklistLocale;
} = $props();

// The note's one slide is the one the server seeds. A recovery state may have
// none yet; the empty card is then exactly what a reader would meet.
let slide = $derived(slides[0] ?? null);
let note = $derived<FeatureNote>({
	id: "preview",
	name,
	snapshotId: "preview",
	title: { en: slide?.titleEn ?? "", hu: slide?.titleHu ?? "" },
	body: { en: slide?.bodyEn ?? "", hu: slide?.bodyHu ?? "" },
	actionLabel: {
		en: slide?.actionLabelEn ?? "",
		hu: slide?.actionLabelHu ?? "",
	},
	actionDestination: slide?.actionUrl?.trim() || null,
	publishedAt: null,
});
</script>

<div class="note-preview" data-testid="note-preview" inert>
	<FeatureNoteStrip {note} {locale} preview />
</div>

<style>
	.note-preview {
		min-width: 0;
		padding-bottom: 0.75rem;
	}
</style>
