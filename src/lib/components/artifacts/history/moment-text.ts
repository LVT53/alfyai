/**
 * What a moment says, in the reader's language (ruling 76, versioning.md §3.2,
 * §5.1 and §8). The server hands over FACTS (who, what kind, which blocks, how
 * many lines, which version a restore brought back: `shared/artifacts/
 * history.ts`); this module is the one place that turns them into words, so one
 * set of strings serves both authors in both languages and the server never
 * writes English a Hungarian reader would see.
 *
 * It replaces `document/version-summary.ts` for History (that file stays until
 * the last sheet that reads it is gone). The panel header imports this module
 * directly, so it stays small: no component, no heavy dependency.
 */

import type { LatestMoment } from "$lib/client/artifact-versions";
import type { I18nKey } from "$lib/i18n";
import type { MomentAuthor, MomentKind } from "$lib/shared/artifacts/history";
import type { ArtifactKind } from "$lib/shared/artifacts/kinds";
import { formatRelativeTime } from "$lib/utils/time";

type Translate = (
	key: I18nKey,
	params?: Record<string, string | number>,
) => string;

type PhraseKey = Extract<I18nKey, `artifacts.history.phrase.${string}`>;

/**
 * The header's short headline for the latest moment, by who did what:
 * "Edited by you", "Changed by Alfy", "Written by Alfy", "Built by Alfy",
 * "Restored by you", "Rebuilt by Alfy", "Alfy's change undone", "Brought back by
 * you". `kind` is the NEWEST row's (an Undo, not the Alfy change it was folded
 * onto). With the kind unknown (an item freshly opened from a server that does
 * not say) the author is still told; with neither it is plain "Edited".
 */
export function momentPhraseKey(
	artifactKind: ArtifactKind,
	author: MomentAuthor | null,
	kind: MomentKind | null,
): PhraseKey {
	switch (kind) {
		case "first_draft":
		case "made_again":
			return artifactKind === "document"
				? "artifacts.history.phrase.alfyWrote"
				: "artifacts.history.phrase.alfyBuilt";
		case "kept_from_chat":
			return "artifacts.history.phrase.alfyWrote";
		case "app_made":
			return "artifacts.history.phrase.alfyBuilt";
		case "app_rebuilt":
			return "artifacts.history.phrase.alfyRebuilt";
		case "alfy_edit":
		case "alfy_reply_edit":
		case "alfy_turn":
			return "artifacts.history.phrase.alfyChanged";
		case "restore":
			return "artifacts.history.phrase.youRestored";
		case "undo_alfy_change":
			return "artifacts.history.phrase.youUndid";
		case "redo_alfy_change":
			return "artifacts.history.phrase.youBroughtBack";
		case "user_edit":
		case "tick":
		case "saved_as_copy":
		case "undo_restore":
			return "artifacts.history.phrase.youEdited";
		default:
			return author === "alfy"
				? "artifacts.history.phrase.alfyChanged"
				: author === "user"
					? "artifacts.history.phrase.youEdited"
					: "artifacts.history.phrase.edited";
	}
}

function lowerFirst(text: string): string {
	return text.length === 0 ? text : text[0].toLowerCase() + text.slice(1);
}

/** The history button's words (see `latestMomentPhrase`). */
export interface MomentPhrase {
	/** "Changed by Alfy": the part that gives way to a narrow header. */
	headline: string;
	/** "12 min ago": the part that never does. `null` when nothing says when. */
	when: string | null;
	/** "Changed by Alfy · 12 min ago". */
	text: string;
	/** One sentence for a screen reader: "History. Last change: changed by Alfy 12 min ago". */
	a11y: string;
}

/**
 * The history button's words: the headline and the time apart (the header
 * truncates the headline before it would ever cut the time), the visible text
 * ("Changed by Alfy · 12 min ago") and the accessible name, which reads as one
 * sentence. `null` when nothing is known about the item's latest moment, so the
 * header says nothing rather than something false.
 */
export function latestMomentPhrase(
	artifactKind: ArtifactKind,
	moment: Pick<LatestMoment, "author" | "kind" | "at"> | null,
	translate: Translate,
): MomentPhrase | null {
	if (moment === null) return null;
	const headline = translate(
		momentPhraseKey(artifactKind, moment.author, moment.kind),
	);
	const when =
		moment.at !== null ? formatRelativeTime(moment.at, { t: translate }) : null;
	return {
		headline,
		when,
		text: when ? `${headline} · ${when}` : headline,
		a11y: translate("artifacts.history.buttonA11y", {
			phrase: when ? `${lowerFirst(headline)} ${when}` : lowerFirst(headline),
		}),
	};
}
