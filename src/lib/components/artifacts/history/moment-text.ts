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
import type { RailEntry } from "./rail-model";

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

// ---- the rail's words (versioning.md §3.2, §5.3, §8) ------------------------

/** The language and clock the rail's sentences are written with. `now` is injected so a test (and a live region) never depends on the wall clock. */
export interface TextContext {
	t: Translate;
	lang: "en" | "hu";
	now: number;
	/** The reader's name for a version, when the rail has it loaded: a restore of a named version says the name, not the day. */
	labelOf?: (versionId: string) => string | null;
}

function localeOf(lang: "en" | "hu"): string {
	return lang === "hu" ? "hu-HU" : "en-GB";
}

function capitalize(text: string): string {
	return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

/** `10:09`, in the 24-hour clock both languages of the app use. */
export function clockTime(at: number, lang: "en" | "hu"): string {
	return new Intl.DateTimeFormat(localeOf(lang), {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(at);
}

function startOfDay(at: number): number {
	const date = new Date(at);
	return new Date(
		date.getFullYear(),
		date.getMonth(),
		date.getDate(),
	).getTime();
}

/** Whole local days between two times (`now`'s day minus `at`'s day). */
function daysAgo(at: number, now: number): number {
	return Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
}

/**
 * The time column of a rail row: relative under an hour ("just now", "12 min
 * ago"), otherwise the clock inside its day group ("10:09"), so two entries of
 * yesterday never read the same.
 */
export function entryTimeLabel(at: number, ctx: TextContext): string {
	const diff = ctx.now - at;
	if (diff >= 0 && diff < 30_000) return ctx.t("time.relative.justNow");
	if (diff >= 0 && diff < 3_600_000) {
		return ctx.t("time.relative.minutes", {
			count: Math.max(1, Math.round(diff / 60_000)),
		});
	}
	return clockTime(at, ctx.lang);
}

/**
 * A burst's span ("10:03–10:09") when its first save is known and a minute or
 * more before its last; `null` otherwise, and the row shows its time alone.
 */
export function entrySpanLabel(
	startedAt: number | null,
	at: number,
	ctx: TextContext,
): string | null {
	if (startedAt === null || at - startedAt < 60_000) return null;
	return `${clockTime(startedAt, ctx.lang)}–${clockTime(at, ctx.lang)}`;
}

/** A day group's heading: Today, Yesterday, then the weekday and the date in the reader's locale. */
export function dayLabel(at: number, ctx: TextContext): string {
	const ago = daysAgo(at, ctx.now);
	if (ago === 0) return ctx.t("artifacts.history.today");
	if (ago === 1) return ctx.t("artifacts.history.yesterday");
	return new Intl.DateTimeFormat(localeOf(ctx.lang), {
		weekday: "long",
		day: "numeric",
		month: "long",
	}).format(at);
}

/**
 * A day and time inside a sentence ("yesterday 10:09", "Monday 10:09"): today,
 * yesterday, the weekday within the last week, the date beyond it. Hungarian
 * puts the time after the day with no suffix on it (a time takes a suffix that
 * depends on how its last number is said, so the sentence brackets it).
 */
export function whenLabel(at: number, ctx: TextContext): string {
	const clock = clockTime(at, ctx.lang);
	const ago = daysAgo(at, ctx.now);
	if (ago === 0) {
		return `${lowerFirst(ctx.t("artifacts.history.today"))} ${clock}`;
	}
	if (ago === 1) {
		return `${lowerFirst(ctx.t("artifacts.history.yesterday"))} ${clock}`;
	}
	if (ago > 1 && ago < 7) {
		const weekday = new Intl.DateTimeFormat(localeOf(ctx.lang), {
			weekday: "long",
		}).format(at);
		return `${weekday} ${clock}`;
	}
	const date = new Intl.DateTimeFormat(localeOf(ctx.lang), {
		day: "numeric",
		month: "short",
	}).format(at);
	return `${date}, ${clock}`;
}

export function statusLabel(
	status: "waiting" | "kept" | "undone" | "partly_kept",
	translate: Translate,
): string {
	switch (status) {
		case "waiting":
			return translate("artifacts.history.status.waiting");
		case "kept":
			return translate("artifacts.history.status.kept");
		case "undone":
			return translate("artifacts.history.status.undone");
		case "partly_kept":
			return translate("artifacts.history.status.partly");
	}
}

/**
 * Who did what, as one headline (versioning.md §3.2). A folded step ("You undid
 * it") is shorter than the same row standing alone ("You undid Alfy's change
 * “Rainy-day plan”"), because under its moment it is already clear which
 * change.
 */
export function entryHeadline(
	entry: RailEntry,
	ctx: TextContext,
	artifactKind: ArtifactKind = "document",
): string {
	const { t } = ctx;
	const text = entry.text?.trim() ? entry.text.trim() : null;
	switch (entry.kind) {
		case "first_draft":
			return artifactKind === "canvas"
				? t("artifacts.history.moment.firstDraftBoard")
				: t("artifacts.history.moment.firstDraft");
		case "app_made":
			return t("artifacts.history.moment.appMade");
		case "kept_from_chat":
			return t("artifacts.history.moment.keptFromChat");
		case "saved_as_copy":
			return t("artifacts.history.moment.savedAsCopy");
		case "made_again":
			return t("artifacts.history.moment.madeAgain");
		case "user_edit":
			return artifactKind === "canvas"
				? t("artifacts.history.moment.youChangedBoard")
				: t("artifacts.history.moment.youEdited");
		case "tick": {
			const tick = entry.moment.tick;
			if (!tick) return t("artifacts.history.moment.youEdited");
			return t(
				tick.checked
					? "artifacts.history.moment.tick"
					: "artifacts.history.moment.untick",
				{ text: tick.text },
			);
		}
		case "alfy_edit":
			return text
				? t("artifacts.history.moment.alfyEdit", { text })
				: t("artifacts.history.moment.alfyEditFallback");
		case "alfy_reply_edit":
			return t("artifacts.history.moment.alfyReplyEdit");
		case "app_rebuilt":
			return text
				? t("artifacts.history.moment.appRebuilt", { text })
				: t("artifacts.history.moment.appMade");
		case "undo_alfy_change": {
			if (entry.folded) return t("artifacts.history.moment.undidFolded");
			const target = entry.moment.target?.text?.trim();
			return target
				? t("artifacts.history.moment.undidNamed", { text: target })
				: t("artifacts.history.moment.undid");
		}
		case "redo_alfy_change":
			return t("artifacts.history.moment.redid");
		case "restore": {
			const from = entry.moment.restoredFrom;
			if (!from) return t("artifacts.history.moment.restoredEarlier");
			const name = ctx.labelOf?.(from.versionId);
			return name
				? t("artifacts.history.moment.restoredNamed", { name })
				: t("artifacts.history.moment.restored", {
						when: whenLabel(from.at, ctx),
					});
		}
		case "undo_restore":
			return t("artifacts.history.moment.undidRestore");
		case "alfy_turn":
			return t("artifacts.history.moment.alfyTurn", {
				count: entry.moment.steps.length,
			});
	}
}

/**
 * What a moment changed, as a noun phrase that serves both authors in both
 * languages (versioning.md §3.2): "Changed “Saturday” and 2 more · in Budget",
 * "1 added, 3 moved", "42 lines changed". `null` when there is nothing to say.
 */
export function entryDetail(
	entry: RailEntry,
	ctx: TextContext,
	artifactKind: ArtifactKind = "document",
): string | null {
	const { t } = ctx;
	const detail = entry.moment.detail;
	if (entry.type === "step") return null;
	switch (detail.type) {
		case "none":
			return null;
		case "large":
			return t("artifacts.history.detail.large");
		case "app": {
			const lines = detail.linesAdded + detail.linesRemoved;
			return lines > 0
				? t("artifacts.history.detail.lines", { count: lines })
				: null;
		}
		case "document": {
			const parts: string[] = [];
			const { changed, added, removed } = detail;
			if (changed.count > 0) {
				parts.push(
					changed.first
						? changed.count === 1
							? t("artifacts.history.detail.changed", { label: changed.first })
							: t("artifacts.history.detail.changedMore", {
									label: changed.first,
									n: changed.count - 1,
								})
						: t("artifacts.history.detail.changedPlain", {
								count: changed.count,
							}),
				);
			}
			if (added.count > 0) {
				parts.push(
					added.first
						? added.count === 1
							? t("artifacts.history.detail.added", { label: added.first })
							: t("artifacts.history.detail.addedMore", {
									label: added.first,
									n: added.count - 1,
								})
						: t("artifacts.history.detail.addedPlain", { count: added.count }),
				);
			}
			if (removed.count > 0) {
				parts.push(
					t("artifacts.history.detail.removed", { count: removed.count }),
				);
			}
			if (parts.length === 0) return null;
			if (detail.tab) {
				parts.push(t("artifacts.history.detail.inTab", { tab: detail.tab }));
			}
			return parts.join(" · ");
		}
		case "canvas": {
			void artifactKind;
			const added = detail.blocksAdded.count + detail.arrowsAdded;
			const changed =
				detail.blocksChanged.count +
				detail.blocksReparented +
				detail.arrowsChanged;
			const removed = detail.blocksRemoved.count + detail.arrowsRemoved;
			const parts: string[] = [];
			if (added > 0) {
				parts.push(t("artifacts.history.detail.canvasAdded", { count: added }));
			}
			if (changed > 0) {
				parts.push(
					t("artifacts.history.detail.canvasChanged", { count: changed }),
				);
			}
			if (detail.blocksMoved > 0) {
				parts.push(
					t("artifacts.history.detail.canvasMoved", {
						count: detail.blocksMoved,
					}),
				);
			}
			if (removed > 0) {
				parts.push(
					t("artifacts.history.detail.canvasRemoved", { count: removed }),
				);
			}
			return parts.length > 0 ? parts.join(", ") : null;
		}
	}
}

/**
 * One option read as one sentence for a screen reader: the reader's name for
 * the version, the day and time, the headline, what changed and where it
 * stands ("Yesterday 10:12, Alfy: Rainy-day plan. New: “Rain”. Undone.").
 */
export function entryA11yName(
	entry: RailEntry,
	ctx: TextContext,
	artifactKind: ArtifactKind = "document",
): string {
	const parts: string[] = [];
	if (entry.label) parts.push(`${entry.label}.`);
	parts.push(
		`${capitalize(whenLabel(entry.at, ctx))}, ${entryHeadline(entry, ctx, artifactKind)}.`,
	);
	const detail = entryDetail(entry, ctx, artifactKind);
	if (detail) parts.push(`${detail}.`);
	if (entry.type === "moment" && entry.moment.status) {
		parts.push(`${statusLabel(entry.moment.status, ctx.t)}.`);
	}
	if (entry.moment.containsNewest && entry.type === "moment") {
		parts.push(`${ctx.t("artifacts.history.now")}.`);
	} else if (entry.sameAsNow) {
		parts.push(`${ctx.t("artifacts.history.sameAsNow")}.`);
	}
	return parts.join(" ");
}
