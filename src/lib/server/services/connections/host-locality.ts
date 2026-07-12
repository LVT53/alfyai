// Single owner of the private/loopback/link-local host classifier. Both the
// SSRF guard (assertPublicHttpsUrl, used by the Nextcloud connect flow and the
// github/immich/plex/caldav providers) and the cloud-connector warning
// (isCloudModel in locality.ts) resolve to the ONE classifier here — this
// module replaces the two byte-for-byte copies that previously lived in net.ts
// and providers/nextcloud-files.ts.

// IPv4 octets that make a host loopback/private/link-local (RFC1918 +
// RFC3927 + loopback). Only used for literal dotted-quad hostnames — DNS
// names are not resolved here (see assertPublicHttpsUrl doc comment).
function isPrivateOrLoopbackIpv4(hostname: string): boolean {
	const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!match) return false;
	const octets = match.slice(1).map(Number);
	if (octets.some((n) => n < 0 || n > 255)) return false;
	const [a, b] = octets;
	if (a === 127) return true; // loopback (127.0.0.0/8)
	if (a === 10) return true; // RFC1918
	if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
	if (a === 192 && b === 168) return true; // RFC1918
	if (a === 169 && b === 254) return true; // link-local
	if (a === 0) return true; // "this network"
	return false;
}

const PRIVATE_HOSTNAMES = new Set([
	"localhost",
	"localhost.localdomain",
	"ip6-localhost",
	"ip6-loopback",
]);

function isLoopbackOrLinkLocalIpv6(hostname: string): boolean {
	const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
	if (h.startsWith("fe80:")) return true; // link-local
	return false;
}

/**
 * True when `host` (a URL hostname, no port/brackets required) points at a
 * loopback, link-local, or RFC1918-private address, `localhost`, or a
 * `*.local` mDNS name. Used both to decide whether a chat model's provider is
 * the on-box local model (no cloud-connector warning needed) vs. a third-party
 * cloud endpoint, and — via assertPublicHttpsUrl — as the private-host half of
 * the SSRF guard.
 */
export function isPrivateHostname(host: string): boolean {
	const hostname = host.toLowerCase().trim();
	if (hostname.length === 0) return false;
	if (PRIVATE_HOSTNAMES.has(hostname)) return true;
	if (hostname.endsWith(".local")) return true;
	if (isPrivateOrLoopbackIpv4(hostname)) return true;
	if (hostname.includes(":") && isLoopbackOrLinkLocalIpv6(hostname)) {
		return true;
	}
	return false;
}

// Matches a leading URL scheme ("https://", "http://", "ftp://", ...) per
// RFC 3986 (`scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )` followed by
// ":"). Used only to decide whether `assertPublicHttpsUrl` needs to prepend
// `https://` to a bare host/origin — every other check below still runs
// unchanged afterwards, so this never widens what the guard accepts beyond
// "a scheme-less value is treated as if the user had typed https:// first".
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

// SSRF guard shared by the Nextcloud connect start/poll routes and the
// github/immich/plex/caldav providers: a serverUrl a user supplies is fetched
// server-side with the request's own secrets attached (or used to derive a URL
// that is), so it must be a public https origin — not
// loopback/link-local/private. This intentionally does NOT resolve DNS (no
// protection against DNS rebinding to a private IP behind a public hostname);
// real-world instances used by this app are public (e.g. https://alfycloud.hu),
// so self-hosted/private-network servers are out of scope for now.
//
// Bare-host convenience: a value with no scheme at all (e.g.
// `cloud.example.com`, optionally with a port/path like
// `cloud.example.com:8443/dav`) is normalized to `https://<value>` before
// anything else runs — https is the only scheme this guard ever accepts, so
// assuming it for scheme-less input just saves the user typing it. A value
// that already names an explicit scheme (including `http://`, which still
// fails the https check below exactly as before) is left byte-for-byte
// untouched.
export function assertPublicHttpsUrl(value: string): string {
	const trimmed = value.trim();
	const withScheme = URL_SCHEME_RE.test(trimmed)
		? trimmed
		: `https://${trimmed}`;

	let parsed: URL;
	try {
		parsed = new URL(withScheme);
	} catch {
		throw new Error("serverUrl must be a valid absolute URL");
	}

	if (parsed.protocol !== "https:") {
		throw new Error("serverUrl must use https");
	}

	if (isPrivateHostname(parsed.hostname)) {
		throw new Error("serverUrl must not point to a private or loopback host");
	}

	return withScheme.replace(/\/+$/, "");
}
