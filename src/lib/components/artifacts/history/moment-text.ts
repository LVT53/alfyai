/**
 * What a moment says in the rail and the preview, in the reader's language
 * (ruling 76, versioning.md §3.2, §5.3 and §8). The server hands over FACTS
 * (who, what kind, which blocks, how many lines, which version a restore
 * brought back: `shared/artifacts/history.ts`); this module is the one place
 * that turns them into words, so one set of strings serves both authors in
 * both languages and the server never writes English a Hungarian reader would
 * see.
 *
 * It replaced the old Versions sheet's own localizer. Only the lazy History part
 * imports it; the short phrase the panel header, the rows and the card print is
 * `moment-phrase.ts`.
 */

import type { ArtifactKind } from "$lib/shared/artifacts/kinds";
import { lowerFirst, type Translate } from "./moment-phrase";
import { entryIsNow, type RailEntry } from "./rail-model";

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
 * How far ahead of the rail's clock a time may be and still be "just now". The
 * clock ticks every 30 seconds, so a version saved since the last tick is up to
 * that far ahead of it; the second tick of slack covers a browser clock a little
 * behind the server's.
 */
const CLOCK_SLACK_MS = 60_000;

/**
 * The time column of a rail row: relative under an hour ("just now", "12 min
 * ago"), otherwise the clock inside its day group ("10:09"), so two entries of
 * yesterday never read the same.
 */
export function entryTimeLabel(at: number, ctx: TextContext): string {
	const diff = ctx.now - at;
	if (diff > -CLOCK_SLACK_MS && diff < 30_000) {
		return ctx.t("time.relative.justNow");
	}
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
	if (entryIsNow(entry)) {
		parts.push(`${ctx.t("artifacts.history.now")}.`);
	} else if (entry.sameAsNow) {
		parts.push(`${ctx.t("artifacts.history.sameAsNow")}.`);
	} else if (entry.sameAs) {
		parts.push(
			`${ctx.t("artifacts.history.sameAs", { when: whenLabel(entry.sameAs.at, ctx) })}.`,
		);
	}
	const restoredHere =
		entry.type === "moment" ? entry.moment.restoredHere[0] : null;
	if (restoredHere) {
		parts.push(
			`${ctx.t("artifacts.history.restoredFromHere", { when: whenLabel(restoredHere.at, ctx) })}.`,
		);
	}
	return parts.join(" ");
}
