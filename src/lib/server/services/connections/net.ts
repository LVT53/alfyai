// Shared hostname-locality classifier used by the Option-C cloud-connector
// guard (see locality.ts). This intentionally duplicates the IPv4/IPv6
// classification logic in providers/nextcloud-files.ts's SSRF guard rather
// than importing from it — that file's assertPublicHttpsUrl has its own
// narrower purpose (reject private *serverUrl* input) and must not change
// behavior as a side effect of this task. Centralizing both call sites onto
// one helper is a follow-up, not part of this change.

// IPv4 octets that make a host loopback/private/link-local (RFC1918 +
// RFC3927 + loopback). Only used for literal dotted-quad hostnames — DNS
// names are not resolved here.
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
 * `*.local` mDNS name. Used to decide whether a chat model's provider is the
 * on-box local model (no cloud-connector warning needed) or a third-party
 * cloud endpoint (warn before sending connector data).
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
