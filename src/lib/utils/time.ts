export type RelativeTimeTranslate = (
	key:
		| "time.relative.justNow"
		| "time.relative.minutes"
		| "time.relative.hours"
		| "time.relative.yesterday",
	params?: Record<string, string | number>,
) => string;

export interface FormatRelativeTimeOptions {
	/** The app's `$t`; without it the English fallback is used. */
	t?: RelativeTimeTranslate;
	/** BCP 47 tag for the date fallback; defaults to the browser's locale. */
	locale?: string;
}

const ENGLISH_FALLBACK: RelativeTimeTranslate = (key, params) => {
	const count = Number(params?.count ?? 0);
	switch (key) {
		case "time.relative.justNow":
			return "just now";
		case "time.relative.minutes":
			return `${count} min ago`;
		case "time.relative.hours":
			return count === 1 ? "1 hour ago" : `${count} hours ago`;
		case "time.relative.yesterday":
			return "Yesterday";
	}
};

/**
 * "just now", "5 min ago", "2 hours ago", "Yesterday", then a short date.
 * Pass `$t` so the words follow the interface language; the English fallback
 * exists for callers with no dictionary in reach.
 */
export function formatRelativeTime(
	unixTimestamp: number,
	options: FormatRelativeTimeOptions = {},
): string {
	const t = options.t ?? ENGLISH_FALLBACK;
	const now = Date.now();
	const timestampMs =
		unixTimestamp < 10000000000 ? unixTimestamp * 1000 : unixTimestamp;
	const diffMs = now - timestampMs;

	if (diffMs < 30000) {
		return t("time.relative.justNow");
	}

	const diffMins = Math.round(diffMs / 60000);
	if (diffMins < 60) {
		return t("time.relative.minutes", { count: diffMins });
	}

	const diffHours = Math.round(diffMs / 3600000);
	if (diffHours < 24) {
		return t("time.relative.hours", { count: diffHours });
	}

	if (diffHours >= 24 && diffHours < 48) {
		return t("time.relative.yesterday");
	}

	const date = new Date(timestampMs);
	return new Intl.DateTimeFormat(options.locale ?? undefined, {
		month: "short",
		day: "numeric",
	}).format(date);
}

export function formatMediumDateTime(
	timestamp: number | null | undefined,
): string {
	if (timestamp == null || !Number.isFinite(timestamp)) {
		return "—";
	}

	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(timestamp);
}
