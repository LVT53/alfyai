/**
 * SSRF-hardened domain validation for the favicon proxy (ADR 0043, Slice 12).
 *
 * The favicon route forwards a user-supplied hostname into outbound HTTPS
 * requests. Without validation, an attacker could ask the server to fetch
 * `http://169.254.169.254/...` (cloud metadata) or an internal service.
 * This validator only ever permits a public, resolvable DNS hostname — never
 * an IP literal, never a private/loopback/link-local address, never a string
 * carrying a scheme/port/path.
 *
 * @returns the normalized (lowercased, www-stripped) hostname, or `null` if
 * the input must be rejected.
 */
export function validateFaviconDomain(input: unknown): string | null {
	if (typeof input !== "string") return null;

	const raw = input.trim();
	if (raw.length === 0 || raw.length > 253) return null;

	// Reject anything that smells like a URL: scheme, port, path, query,
	// fragment, or credentials. We only ever want a bare hostname.
	if (/[/:?#@[\]\\]/.test(raw)) return null;
	// Reject embedded whitespace.
	if (/\s/.test(raw)) return null;

	const hostname = raw.toLowerCase().replace(/^www\./, "");

	if (!isAcceptableHostname(hostname)) return null;

	return hostname;
}

/**
 * A hostname is acceptable iff it is a DNS name (not an IP literal), has a
 * public suffix + at least one label, and does not resolve into a known
 * internal/private range by *shape*. (We can't see DNS here, so we block by
 * pattern; the actual fetch also forces https and does not follow redirects
 * to internal addresses — see the route handler.)
 */
function isAcceptableHostname(hostname: string): boolean {
	// Every label: [a-z0-9-], no leading/trailing hyphen, 1-63 chars.
	const label = /[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?/;
	const dns = new RegExp(`^${label.source}(\\.${label.source})+$`);
	if (!dns.test(hostname)) return false;

	// Reject IP literals outright (IPv4 dotted-quad / IPv6 / bracketed).
	if (isIpLiteral(hostname)) return false;

	// Reject obviously-internal hostnames even if they parse as DNS-ish.
	if (isInternalHostname(hostname)) return false;

	return true;
}

function isIpLiteral(hostname: string): boolean {
	// IPv4 dotted quad.
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
	// IPv6 (may contain ':'); a DNS label can never contain ':'.
	if (hostname.includes(":")) return true;
	return false;
}

function isInternalHostname(hostname: string): boolean {
	// Common internal hostnames that are valid DNS shapes but must be blocked.
	const blocked = new Set([
		"localhost",
		"localhost.localdomain",
		"metadata",
		"metadata.google.internal", // GCP metadata
	]);
	if (blocked.has(hostname)) return true;

	// IPv4 private/loopback/link-local ranges expressed as dotted-quads —
	// these are already rejected as IP literals above, but keep an explicit
	// guard in case the literal test is ever loosened.
	const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (m) {
		const [a, b] = [Number(m[1]), Number(m[2])];
		if (
			a === 10 || // private 10/8
			a === 127 || // loopback 127/8
			(a === 172 && b >= 16 && b <= 31) || // private 172.16/12
			(a === 192 && b === 168) || // private 192.168/16
			(a === 169 && b === 254) || // link-local 169.254/16 (cloud metadata)
			a === 0 || // 0/8 "this host"
			a >= 224 // multicast / reserved (224/4, 240/4)
		) {
			return true;
		}
	}
	return false;
}
