/**
 * What a row of the panel's list says beyond its title and its kind, so that rows
 * with one name can be told apart (FB-5, ruling 77: F9).
 *
 * The audit's chat had two Apps called "Borravaló-kalkulátor", two identical DOCX
 * files and a board beside its own PNG: every row carried a title, a kind and an
 * age, and nothing that told one from the other. A file row now says its extension
 * and its size ("PDF · 363.1 KB"); a row whose name another row shares says when it
 * was made ("14:32", "Oct 11, 14:32"), because two rows of one name are the same
 * thing a reader can only tell by when. A version number is not it (ruling 76: a
 * number is not something a reader remembers).
 *
 * Pure: no component, no store. (History's own clock, `history/moment-text.ts`'s
 * `clockTime`, is in a part that loads lazily; the list is in the chat's first
 * paint and must not pull it in.)
 */

import { formatByteSize } from "$lib/utils/format";

/** The extension of a file name as a row prints it ("PDF" for "trip.pdf"); `null` for a name with none, or one that is not an extension. */
function fileExtensionLabel(filename: string): string | null {
	const dot = filename.lastIndexOf(".");
	if (dot <= 0 || dot === filename.length - 1) return null;
	const extension = filename.slice(dot + 1);
	return /^[A-Za-z0-9]{1,8}$/.test(extension) ? extension.toUpperCase() : null;
}

/** "PDF · 363.1 KB": the facts a produced file's row adds to its kind. Either part is left out when it is not known; `null` when neither is. */
export function fileFacts(file: {
	filename: string;
	sizeBytes?: number | null;
}): string | null {
	const parts = [
		fileExtensionLabel(file.filename),
		file.sizeBytes == null
			? null
			: formatByteSize(file.sizeBytes, { trimWholeUnits: true }),
	].filter((part): part is string => part !== null);
	return parts.length > 0 ? parts.join(" · ") : null;
}

/** A title as a reader compares it: surrounding space and capitals do not make two names different. */
function nameKey(title: string): string {
	return title.trim().toLocaleLowerCase();
}

/** The names that more than one of these rows has (as `nameKey`s: ask `isShared`). */
export function sharedNames(titles: readonly string[]): Set<string> {
	const seen = new Set<string>();
	const shared = new Set<string>();
	for (const title of titles) {
		const key = nameKey(title);
		if (seen.has(key)) shared.add(key);
		else seen.add(key);
	}
	return shared;
}

export function isShared(shared: ReadonlySet<string>, title: string): boolean {
	return shared.has(nameKey(title));
}

/**
 * When a row was made, in words that differ between two rows of one name: the clock
 * for today ("14:32"), the day and the clock for any other day ("Oct 11, 14:32",
 * "okt. 11. 14:32"), in the 24-hour clock both of the app's languages use.
 */
export function rowMadeAtLabel(
	at: number,
	lang: "en" | "hu",
	now: number = Date.now(),
): string {
	// A unix time in seconds is read as one, as `formatRelativeTime` reads it.
	const madeAtMs = at < 10_000_000_000 ? at * 1000 : at;
	const locale = lang === "hu" ? "hu-HU" : "en-GB";
	const clock = new Intl.DateTimeFormat(locale, {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
	const madeOn = new Date(madeAtMs);
	const today = new Date(now);
	const sameDay =
		madeOn.getFullYear() === today.getFullYear() &&
		madeOn.getMonth() === today.getMonth() &&
		madeOn.getDate() === today.getDate();
	if (sameDay) return clock.format(madeAtMs);
	const day = new Intl.DateTimeFormat(locale, {
		day: "numeric",
		month: "short",
	});
	return `${day.format(madeAtMs)}, ${clock.format(madeAtMs)}`;
}
