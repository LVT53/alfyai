/**
 * Provider-agnostic canonical dedup key for source URLs.
 *
 * Produces a stable string used to detect when two source URLs point at the
 * same document: it drops the fragment, sorts query parameters into a fixed
 * order, strips trailing slashes, and lowercases. On a malformed URL it falls
 * back to a best-effort trim/strip of the raw string. Shared by the search
 * stage (within-round convergence) and the pipeline (cross-round gap-fill and
 * source-reference matching), so both dedup on identical keys.
 */
export function canonicalSourceUrlKey(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.hash = "";
		parsed.searchParams.sort();
		return parsed.toString().replace(/\/+$/, "").toLowerCase();
	} catch {
		return url.trim().replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();
	}
}
