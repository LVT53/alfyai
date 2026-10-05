/**
 * How a campaign names itself in the admin pane's lines (the rail's row and
 * the line above the editor). A tour is a campaign of its own type whose
 * release text is the kind it introduces (ruling 71), so it reads as "Tour ·
 * Canvas", in the words the rest of the interface uses for the kind
 * (`artifacts.type.*`), and never as "Release · canvas".
 */
import type { I18nKey } from "$lib/i18n";
import { isShippedArtifactTourType } from "$lib/shared/artifacts/tours";

type Translate = (key: I18nKey) => string;

/**
 * What a tour campaign's release text reads as: the kind's own word when it
 * names a kind whose tour ships, the text itself when it does not (so a
 * mistake can be read, not hidden), nothing for an empty one.
 */
export function tourKindWord(
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
