export function formatRelativeTime(unixTimestamp: number): string {
	const now = Date.now();
	const timestampMs =
		unixTimestamp < 10000000000 ? unixTimestamp * 1000 : unixTimestamp;
	const diffMs = now - timestampMs;

	if (diffMs < 30000) {
		return "just now";
	}

	const diffMins = Math.round(diffMs / 60000);
	if (diffMins < 60) {
		return `${diffMins} min ago`;
	}

	const diffHours = Math.round(diffMs / 3600000);
	if (diffHours < 24) {
		return `${diffHours} hour ago`;
	}

	if (diffHours >= 24 && diffHours < 48) {
		return "Yesterday";
	}

	const date = new Date(timestampMs);
	return new Intl.DateTimeFormat("en-US", {
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
