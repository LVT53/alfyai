// Shared helpers: stats + URL canonicalization.

export type Stats = {
	count: number;
	min: number;
	p50: number;
	p95: number;
	max: number;
	mean: number;
};

export function stats(values: number[]): Stats | null {
	const nums = values.filter((v) => Number.isFinite(v));
	if (nums.length === 0) return null;
	const sorted = [...nums].sort((a, b) => a - b);
	const pct = (p: number) => {
		const idx = Math.max(
			0,
			Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1),
		);
		return sorted[idx];
	};
	const sum = sorted.reduce((t, v) => t + v, 0);
	return {
		count: sorted.length,
		min: round(sorted[0]),
		p50: round(pct(0.5)),
		p95: round(pct(0.95)),
		max: round(sorted[sorted.length - 1]),
		mean: round(sum / sorted.length),
	};
}

export function round(v: number, dp = 1): number {
	const f = 10 ** dp;
	return Math.round(v * f) / f;
}

export function mean(values: number[]): number {
	const nums = values.filter((v) => Number.isFinite(v));
	if (nums.length === 0) return 0;
	return round(nums.reduce((t, v) => t + v, 0) / nums.length, 2);
}

// Canonicalize a URL to {url, host} for comparison. Strips scheme differences,
// www, trailing slashes, tracking params, and fragments.
export function canonical(
	raw: string,
): { url: string; host: string } | null {
	try {
		const u = new URL(raw.trim().replace(/[.,;:!?]+$/, ""));
		if (u.protocol !== "http:" && u.protocol !== "https:") return null;
		u.hash = "";
		for (const key of [...u.searchParams.keys()]) {
			if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$|ref_src$)/i.test(key)) {
				u.searchParams.delete(key);
			}
		}
		u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
		u.pathname = u.pathname.replace(/\/+$/, "") || "/";
		u.protocol = "https:";
		return { url: u.toString(), host: u.hostname };
	} catch {
		return null;
	}
}

// Registrable-ish host key: last two labels (postgresql.org from www.postgresql.org,
// docs.github.com -> github.com). Good enough for authority-domain matching.
export function hostKey(host: string): string {
	const parts = host.split(".").filter(Boolean);
	if (parts.length <= 2) return host;
	// Handle common two-part TLDs (co.uk, org.uk, etc.) lightly.
	const twoPartTld = /^(co|org|gov|ac|com|net|edu)\.[a-z]{2}$/i;
	const lastTwo = parts.slice(-2).join(".");
	if (twoPartTld.test(lastTwo) && parts.length >= 3) {
		return parts.slice(-3).join(".");
	}
	return lastTwo;
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
