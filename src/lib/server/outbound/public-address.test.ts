import { describe, expect, it } from "vitest";
import { isPublicAddress, isReservedHostname } from "./public-address";

describe("isPublicAddress: IPv4", () => {
	it.each([
		["8.8.8.8"],
		["1.1.1.1"],
		["93.184.216.34"],
		["172.15.255.255"], // just below 172.16/12
		["172.32.0.1"], // just above it
		["100.63.255.255"], // just below CGNAT
		["100.128.0.1"], // just above it
		["198.17.255.255"], // just below benchmarking
		["198.20.0.1"], // just above it
		["223.255.255.254"], // last unicast address
	])("treats %s as public", (address) => {
		expect(isPublicAddress(address)).toBe(true);
	});

	it.each([
		["0.0.0.0", "this network, and this machine"],
		["0.1.2.3", "0/8"],
		["10.0.0.1", "RFC 1918"],
		["10.255.255.255", "RFC 1918"],
		["100.64.0.1", "carrier-grade NAT"],
		["100.127.255.254", "carrier-grade NAT"],
		["127.0.0.1", "loopback"],
		["127.255.255.255", "loopback"],
		["169.254.169.254", "cloud metadata"],
		["172.16.0.1", "RFC 1918"],
		["172.31.255.255", "RFC 1918"],
		["192.0.0.8", "IETF protocol assignments"],
		["192.0.2.1", "TEST-NET-1"],
		["192.88.99.1", "6to4 relay anycast"],
		["192.168.1.1", "RFC 1918"],
		["198.18.0.1", "benchmarking"],
		["198.19.255.255", "benchmarking"],
		["198.51.100.7", "TEST-NET-2"],
		["203.0.113.9", "TEST-NET-3"],
		["224.0.0.1", "multicast"],
		["239.255.255.250", "multicast"],
		["240.0.0.1", "reserved"],
		["255.255.255.255", "broadcast"],
	])("refuses %s (%s)", (address) => {
		expect(isPublicAddress(address)).toBe(false);
	});
});

describe("isPublicAddress: IPv6", () => {
	it.each([
		["2606:4700:4700::1111"], // Cloudflare
		["2001:4860:4860::8888"], // Google
		["2a00:1450:4001:80b::200e"],
		["2600:1f18::1"],
	])("treats %s as public", (address) => {
		expect(isPublicAddress(address)).toBe(true);
	});

	it.each([
		["::", "unspecified"],
		["0:0:0:0:0:0:0:0", "unspecified, long form"],
		["::1", "loopback"],
		["0:0:0:0:0:0:0:1", "loopback, long form"],
		["fe80::1", "link-local"],
		["febf::1", "link-local, top of fe80::/10"],
		["fc00::1", "unique-local"],
		["fd12:3456:789a::1", "unique-local"],
		["fec0::1", "site-local (deprecated)"],
		["ff02::1", "multicast"],
		["ff0e::1", "multicast, global scope"],
		["100::1", "discard-only"],
		["2001:db8::1", "documentation"],
		["2001:db8:ffff::1", "documentation"],
		["3fff::1", "documentation (RFC 9637)"],
		["3fff:fff::1", "documentation (RFC 9637), top of the /20"],
		["2001::1", "Teredo"],
		["2001:0:4136:e378:8000:63bf:3fff:fdd2", "Teredo, the RFC 4380 example"],
		["2001:2::1", "benchmarking"],
		["2001:10::1", "ORCHID"],
		["2001:1ff::1", "top of 2001::/23"],
		["5f00::1", "SRv6 SIDs"],
		["64:ff9b:1::1", "local-use NAT64"],
		["fe80::1%en0", "a zone id names an interface of this machine"],
		["not an address", "not an address at all"],
		["", "empty"],
	])("refuses %s (%s)", (address) => {
		expect(isPublicAddress(address)).toBe(false);
	});

	it("does not refuse the first address past 2001::/23", () => {
		expect(isPublicAddress("2001:200::1")).toBe(true);
	});
});

describe("isPublicAddress: IPv4 inside IPv6", () => {
	it.each([
		// IPv4-mapped: a dual-stack socket connects to the IPv4 address.
		["::ffff:7f00:1", "mapped loopback, hex form (the audit's case)"],
		["::ffff:127.0.0.1", "mapped loopback, dotted form"],
		["::FFFF:7F00:1", "mapped loopback, upper case"],
		["0:0:0:0:0:ffff:7f00:1", "mapped loopback, long form"],
		["::ffff:a00:1", "mapped 10.0.0.1"],
		["::ffff:169.254.169.254", "mapped cloud metadata"],
		["::ffff:6440:1", "mapped 100.64.0.1 (CGNAT)"],
		["::ffff:0:0", "mapped 0.0.0.0"],
		// IPv4-compatible: deprecated, and nothing public lives there.
		["::7f00:1", "compatible loopback"],
		["::127.0.0.1", "compatible loopback, dotted"],
		["::808:808", "compatible 8.8.8.8 is still refused"],
		// NAT64: a gateway forwards to the embedded address.
		["64:ff9b::7f00:1", "NAT64 loopback"],
		["64:ff9b::a9fe:a9fe", "NAT64 cloud metadata"],
		["64:ff9b::10.1.2.3", "NAT64 private, dotted"],
		["64:ff9b::c0a8:1", "NAT64 192.168.0.1"],
		// 6to4: the embedded address is in bits 16 to 47.
		["2002:7f00:1::", "6to4 loopback"],
		["2002:a9fe:a9fe::1", "6to4 cloud metadata"],
		["2002:c0a8:101::1", "6to4 192.168.1.1"],
		["2002:ac10:1::1", "6to4 172.16.0.1"],
		["2002:c058:6301::1", "6to4 relay anycast 192.88.99.1"],
	])("refuses %s (%s)", (address) => {
		expect(isPublicAddress(address)).toBe(false);
	});

	it.each([
		["::ffff:808:808", "mapped 8.8.8.8"],
		["::ffff:8.8.8.8", "mapped 8.8.8.8, dotted"],
		["64:ff9b::808:808", "NAT64 of 8.8.8.8, what a DNS64 resolver answers"],
		["64:ff9b::8.8.8.8", "NAT64 of 8.8.8.8, dotted"],
		["2002:808:808::1", "6to4 of 8.8.8.8"],
	])("treats %s as public: the address inside it is (%s)", (address) => {
		expect(isPublicAddress(address)).toBe(true);
	});
});

describe("isReservedHostname", () => {
	it.each([
		["localhost"],
		["LOCALHOST"],
		["localhost."],
		["api.localhost"],
		["printer.local"],
		["metadata.google.internal"],
		["db.internal"],
		["INTERNAL.internal"],
		["nas.lan"],
		["router.home.arpa"],
		["home.arpa"],
		["wiki.intranet"],
		["files.corp"],
		["tv.home"],
		["x.private"],
		["host.localdomain"],
		["intranet"], // no dot: a search-domain shorthand
		["metadata"],
		[""],
	])("refuses %s", (hostname) => {
		expect(isReservedHostname(hostname)).toBe(true);
	});

	it.each([
		["example.com"],
		["www.example.co.uk"],
		["xn--bcher-kva.example"],
		["internal.example.com"], // a label called internal is not the suffix
		["local-news.com"],
		["my.homepage.com"],
		["github.io"],
	])("lets %s through to the address check", (hostname) => {
		expect(isReservedHostname(hostname)).toBe(false);
	});
});
