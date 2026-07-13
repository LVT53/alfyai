import { canonical, hostKey, round } from "./util";

export type RetrievalScore = {
	candidateCount: number;
	goldHostCount: number;
	firstHitRank: number | null; // 1-indexed rank of first host-level gold hit
	hostHitAt3: boolean;
	hostHitAt8: boolean;
	urlHitAt8: boolean; // exact canonical-URL match anywhere in top 8
	mrrHost: number; // 1/firstHitRank (host-level), else 0
	hostRecall: number; // distinct gold hosts found / total gold hosts
};

// Score an ordered list of candidate URLs against the gold URL set.
// Host-level matching is primary: gold_urls name authoritative pages, but a
// provider legitimately "finds the right source" if it returns the same
// authority domain (e.g. any postgresql.org page for a postgres fact).
export function scoreRetrieval(
	candidateUrls: string[],
	goldUrls: string[],
): RetrievalScore {
	const goldCanon = goldUrls
		.map((u) => canonical(u))
		.filter((c): c is { url: string; host: string } => Boolean(c));
	const goldHostKeys = new Set(goldCanon.map((c) => hostKey(c.host)));
	const goldUrlSet = new Set(goldCanon.map((c) => c.url));

	let firstHitRank: number | null = null;
	let urlHitAt8 = false;
	const foundHostKeys = new Set<string>();

	candidateUrls.forEach((raw, i) => {
		const c = canonical(raw);
		if (!c) return;
		const hk = hostKey(c.host);
		const rank = i + 1;
		if (goldHostKeys.has(hk)) {
			if (firstHitRank === null) firstHitRank = rank;
			foundHostKeys.add(hk);
		}
		if (rank <= 8 && goldUrlSet.has(c.url)) urlHitAt8 = true;
	});

	const hostHitAt3 = firstHitRank !== null && firstHitRank <= 3;
	const hostHitAt8 = firstHitRank !== null && firstHitRank <= 8;

	return {
		candidateCount: candidateUrls.length,
		goldHostCount: goldHostKeys.size,
		firstHitRank,
		hostHitAt3,
		hostHitAt8,
		urlHitAt8,
		mrrHost: firstHitRank ? round(1 / firstHitRank, 3) : 0,
		hostRecall: goldHostKeys.size
			? round(foundHostKeys.size / goldHostKeys.size, 3)
			: 0,
	};
}
