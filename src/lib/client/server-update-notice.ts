export const SERVER_UPDATE_REFRESH_SUPPRESSION_KEY =
	"alfyai:server-update-refresh-suppressed-until";

export const SERVER_UPDATE_REFRESH_SUPPRESSION_MS = 60_000;

type TimeSource = () => number;

export function markServerUpdateRefreshRequested(
	storage: Pick<Storage, "setItem">,
	now: TimeSource = Date.now,
): number {
	const suppressedUntil = now() + SERVER_UPDATE_REFRESH_SUPPRESSION_MS;
	storage.setItem(
		SERVER_UPDATE_REFRESH_SUPPRESSION_KEY,
		String(suppressedUntil),
	);
	return suppressedUntil;
}

export function readServerUpdateRefreshSuppressedUntil(
	storage: Pick<Storage, "getItem" | "removeItem">,
	now: TimeSource = Date.now,
): number {
	const rawValue = storage.getItem(SERVER_UPDATE_REFRESH_SUPPRESSION_KEY);
	const suppressedUntil = rawValue ? Number(rawValue) : 0;
	if (!Number.isFinite(suppressedUntil) || suppressedUntil <= now()) {
		storage.removeItem(SERVER_UPDATE_REFRESH_SUPPRESSION_KEY);
		return 0;
	}
	return suppressedUntil;
}
