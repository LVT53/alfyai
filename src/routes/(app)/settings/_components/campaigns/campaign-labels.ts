/**
 * How a campaign names itself in the admin pane's lines (the rail's row and
 * the line above the editor). A tour is a campaign of its own type whose
 * release text is the kind it introduces (ruling 71), so it reads as "Tour ·
 * Canvas", in the words the rest of the interface uses for the kind
 * (`artifacts.type.*`), and never as "Release · canvas".
 */
import type { I18nKey } from "$lib/i18n";
import { isShippedArtifactTourType } from "$lib/shared/artifacts/tours";

type Translate = (
	key: I18nKey,
	params?: Record<string, string | number>,
) => string;

/**
 * What a tour campaign's release text reads as: the kind's own word when it
 * names a kind whose tour ships, the text itself when it does not (so a
 * mistake can be read, not hidden), nothing for an empty one.
 */
function tourKindWord(
	releaseVersion: string | null | undefined,
	t: Translate,
): string {
	const text = releaseVersion?.trim() ?? "";
	return isShippedArtifactTourType(text) ? t(`artifacts.type.${text}`) : text;
}

/** The leading words of a tour's line: "Tour" and the kind, never one without the type. */
export function tourLead(
	releaseVersion: string | null | undefined,
	t: Translate,
): string[] {
	const kind = tourKindWord(releaseVersion, t);
	return kind
		? [t("admin.campaigns.type.tour"), kind]
		: [t("admin.campaigns.type.tour")];
}

/**
 * How many a tour has, in the words of what a reader meets: its steps, and the
 * line an empty item shows. A tour is one summary slide and three steps, so it
 * never reads "4 slides" (RC-T Minor 4). `slideCount` is every slide the
 * campaign holds, which is all the campaign list carries.
 */
export function tourCountLabel(slideCount: number, t: Translate): string {
	return t("admin.campaigns.tour.stepCount", {
		count: Math.max(slideCount - 1, 0),
	});
}

/**
 * The leading words of a feature note's line. A note is not a release and its
 * type is the whole lead: "Feature note", never "Release · 2.4.0".
 */
export function featureNoteLead(t: Translate): string[] {
	return [t("admin.campaigns.type.featureNote")];
}

/**
 * How many a note has, in its own word: one note, never "1 slide". The count
 * is still a count so the pane can say 0 while a note waits for its seeded
 * slide (a recovery state, not the normal one).
 */
export function noteCountLabel(noteCount: number, t: Translate): string {
	return t("admin.campaigns.note.count", {
		count: Math.max(noteCount, 0),
	});
}

/**
 * The number of each slide as a reader counts a tour's steps: the summary slide
 * (the empty-state line) has none, and the slides after it are steps 1, 2, 3
 * whatever their place in the list.
 */
export function tourStepNumbers(
	slides: ReadonlyArray<{ kind: string }>,
): Array<number | null> {
	let step = 0;
	return slides.map((slide) => {
		if (slide.kind === "summary") return null;
		step += 1;
		return step;
	});
}
