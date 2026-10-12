// The one answer to "may this server open a connection to that address on the
// say-so of a model, a web page or a user-written document?".
//
// A check on the TEXT of a host (`localhost`, a dotted quad, a bracketed
// literal) is not an answer: `https://[::ffff:7f00:1]/`, `https://[::]/`, a
// CGNAT address, `printer.internal` and any public name that resolves to
// 127.0.0.1 all pass such a check and all reach the machine's own network. The
// only thing that can be judged is the ADDRESS the socket will connect to, so
// this module classifies addresses, and `fetch.ts` makes the connection use
// exactly the address that was classified.
//
// Fail closed throughout: an address that does not parse, or that sits in a
// range this file does not know, is not public.

import { isIP, isIPv4 } from "node:net";

/** IPv4 blocks that are not the public internet (IANA IPv4 special-purpose registry). */
const IPV4_NOT_PUBLIC: ReadonlyArray<readonly [string, number]> = [
	["0.0.0.0", 8], // "this network" (RFC 791); 0.0.0.0 connects to the local machine
	["10.0.0.0", 8], // private (RFC 1918)
	["100.64.0.0", 10], // carrier-grade NAT (RFC 6598)
	["127.0.0.0", 8], // loopback
	["169.254.0.0", 16], // link-local, which is where cloud metadata services live
	["172.16.0.0", 12], // private (RFC 1918)
	["192.0.0.0", 24], // IETF protocol assignments (RFC 6890)
	["192.0.2.0", 24], // documentation, TEST-NET-1
	["192.88.99.0", 24], // 6to4 relay anycast (deprecated, RFC 7526)
	["192.168.0.0", 16], // private (RFC 1918)
	["198.18.0.0", 15], // benchmarking (RFC 2544)
	["198.51.100.0", 24], // documentation, TEST-NET-2
	["203.0.113.0", 24], // documentation, TEST-NET-3
	["224.0.0.0", 4], // multicast
	["240.0.0.0", 4], // reserved, and the limited broadcast address
];

/** A dotted quad as an unsigned 32-bit number, or null when it is not one. */
function parseIpv4(text: string): number | null {
	if (!isIPv4(text)) return null;
	const [a, b, c, d] = text.split(".").map(Number);
	return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

const IPV4_NOT_PUBLIC_NUMERIC = IPV4_NOT_PUBLIC.map(([base, bits]) => ({
	base: parseIpv4(base) as number,
	bits,
}));

function isPublicIpv4(address: number): boolean {
	return !IPV4_NOT_PUBLIC_NUMERIC.some(
		({ base, bits }) => address >>> (32 - bits) === base >>> (32 - bits),
	);
}

/** An IPv6 address as eight 16-bit words, or null when it is not one. */
function parseIpv6(text: string): number[] | null {
	// A zone id (`fe80::1%en0`) names an interface of THIS machine.
	if (text.includes("%") || isIP(text) !== 6) return null;

	let body = text;
	const lastColon = body.lastIndexOf(":");
	const tail = body.slice(lastColon + 1);
	if (tail.includes(".")) {
		// `::ffff:127.0.0.1`: the last 32 bits written as a dotted quad.
		const quad = parseIpv4(tail);
		if (quad === null) return null;
		body = `${body.slice(0, lastColon + 1)}${(quad >>> 16).toString(16)}:${(quad & 0xffff).toString(16)}`;
	}

	const halves = body.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] === "" ? [] : halves[0].split(":");
	const rest =
		halves.length === 1 || halves[1] === "" ? [] : halves[1].split(":");
	let groups: string[];
	if (halves.length === 1) {
		groups = head;
	} else {
		const missing = 8 - head.length - rest.length;
		if (missing < 1) return null;
		groups = [...head, ...new Array<string>(missing).fill("0"), ...rest];
	}
	if (groups.length !== 8) return null;

	const words = groups.map((group) => Number.parseInt(group, 16));
	return words.every((word) => Number.isInteger(word) && word <= 0xffff)
		? words
		: null;
}

/** The IPv4 address held in the last two words of an IPv6 address. */
function embeddedIpv4(high: number, low: number): number {
	return ((high << 16) | low) >>> 0;
}

function isPublicIpv6(w: number[]): boolean {
	const topEightyZero =
		w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0;

	// ::ffff:a.b.c.d is an IPv4 address in IPv6 clothes. A dual-stack socket
	// connects to the IPv4 address, so that is the address to judge.
	if (topEightyZero && w[5] === 0xffff) {
		return isPublicIpv4(embeddedIpv4(w[6], w[7]));
	}
	// ::/96: the unspecified address (which connects to this machine), the
	// loopback address and the deprecated IPv4-compatible form. Nothing public
	// has ever lived here.
	if (topEightyZero && w[5] === 0) return false;
	// 64:ff9b::/96 (RFC 6052, NAT64): a gateway forwards the packet to the IPv4
	// address in the low 32 bits, so the address is as public as that one.
	if (
		w[0] === 0x64 &&
		w[1] === 0xff9b &&
		w[2] === 0 &&
		w[3] === 0 &&
		w[4] === 0 &&
		w[5] === 0
	) {
		return isPublicIpv4(embeddedIpv4(w[6], w[7]));
	}
	// 2002::/16 (RFC 3056, 6to4): the IPv4 address sits in bits 16 to 47.
	if (w[0] === 0x2002) return isPublicIpv4(embeddedIpv4(w[1], w[2]));

	// What is left is public only inside global unicast, 2000::/3. Everything
	// else (fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast,
	// the 64:ff9b:1::/48 local-use NAT64 block, ::/8 and whatever the IETF
	// reserves next) is refused without being listed.
	if ((w[0] & 0xe000) !== 0x2000) return false;
	// 2001::/23, IETF protocol assignments: Teredo (2001::/32, whose embedded
	// addresses are obfuscated), benchmarking, ORCHID and friends.
	if (w[0] === 0x2001 && w[1] < 0x0200) return false;
	// 2001:db8::/32 and 3fff::/20: documentation.
	if (w[0] === 0x2001 && w[1] === 0x0db8) return false;
	if (w[0] === 0x3fff && (w[1] & 0xf000) === 0) return false;
	return true;
}

/**
 * Whether `address` (the text of an IPv4 or IPv6 address, as a resolver or a
 * URL parser writes it) is one a server may connect to on a stranger's say-so.
 */
export function isPublicAddress(address: string): boolean {
	const quad = parseIpv4(address);
	if (quad !== null) return isPublicIpv4(quad);
	const words = parseIpv6(address);
	return words !== null && isPublicIpv6(words);
}

/**
 * Suffixes that name somebody's private network. Names ending in them (and
 * single-label names) are refused before any lookup: a private resolver may
 * well answer for them, and a public one never should.
 */
const INTERNAL_SUFFIXES = [
	"localhost", // RFC 6761: always loopback
	"local", // RFC 6762: multicast DNS, the LAN
	"localdomain",
	"internal", // reserved for private use (ICANN, 2024)
	"lan",
	"home.arpa", // RFC 8375: the home network
	"intranet",
	"corp",
	"home",
	"private",
] as const;

/** A host name that is certain not to be a public site, judged by its text alone. */
export function isReservedHostname(hostname: string): boolean {
	const name = hostname.toLowerCase().replace(/\.$/, "");
	// `intranet`, `metadata`, `localhost`: a name without a dot is a search-domain
	// shorthand for something on the local network, never a public site.
	if (!name.includes(".")) return true;
	return INTERNAL_SUFFIXES.some(
		(suffix) => name === suffix || name.endsWith(`.${suffix}`),
	);
}
