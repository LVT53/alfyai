/**
 * R16: after a sign-in with a backup code, the first page says how many are
 * left. The count travels in the URL (`/?twoStepBackupLeft=9`) rather than a
 * new raw `sessionStorage` key — `conversation-session.ts` owns those — and
 * the app shell reads it once, shows it as a toast and removes it.
 *
 * Kept as a pure function of the URL so the reading/removal rules are
 * testable without mounting the whole shell.
 */
export function readTwoStepBackupNotice(
	url: URL,
): { count: number; cleaned: URL } | null {
	const raw = url.searchParams.get("twoStepBackupLeft");
	if (raw === null) return null;

	const count = Number.parseInt(raw, 10);
	if (!Number.isFinite(count) || count < 0 || String(count) !== raw.trim()) {
		return null;
	}

	const cleaned = new URL(url);
	cleaned.searchParams.delete("twoStepBackupLeft");
	return { count, cleaned };
}
