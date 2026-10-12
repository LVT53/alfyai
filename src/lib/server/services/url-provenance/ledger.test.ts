import { beforeEach, describe, expect, it } from "vitest";
import {
	LEDGER_MAX_HOSTS_PER_USER,
	LEDGER_MAX_THUMBNAILS_PER_USER,
	LEDGER_MAX_USERS,
	ledgerHasHost,
	ledgerHasThumbnail,
	recordLedgerHosts,
	recordLedgerThumbnails,
	resetLedgerForTests,
} from "./ledger";

// The ledger is what a favicon or thumbnail request is answered from: a host or
// a picture is served only when a tool returned it to THIS user. These cases pin
// who it answers, what it forgets and what it refuses to remember.

const THUMB =
	"https://imgs.search.brave.com/Zq3s9x/rs:fit:500:0:0:0/g:ce/aHR0cHM6Ly9leGFtcGxlLmNvbS9jYXQuanBn";

describe("the source ledger: hosts", () => {
	beforeEach(() => resetLedgerForTests());

	it("answers for a host a tool returned to this user, whatever its case or www", () => {
		recordLedgerHosts("user-1", ["Example.com", "docs.example.org"]);

		expect(ledgerHasHost("user-1", "example.com")).toBe(true);
		expect(ledgerHasHost("user-1", "WWW.EXAMPLE.COM")).toBe(true);
		expect(ledgerHasHost("user-1", "docs.example.org")).toBe(true);
	});

	it("does not answer for a host nobody returned, or a different one that merely resembles it", () => {
		recordLedgerHosts("user-1", ["example.com"]);

		expect(ledgerHasHost("user-1", "example.net")).toBe(false);
		expect(ledgerHasHost("user-1", "secret.example.com")).toBe(false);
		expect(ledgerHasHost("user-1", "xexample.com")).toBe(false);
		expect(ledgerHasHost("user-1", "")).toBe(false);
		expect(ledgerHasHost("user-1", null)).toBe(false);
	});

	it("keeps one user's hosts from another user", () => {
		recordLedgerHosts("user-1", ["example.com"]);

		expect(ledgerHasHost("user-2", "example.com")).toBe(false);
		expect(ledgerHasHost("", "example.com")).toBe(false);
	});

	it("ignores what is not a host: a URL, a path, a port, an address with a user", () => {
		recordLedgerHosts("user-1", [
			"https://example.com/a",
			"example.com/path",
			"example.com:8443",
			"user@example.com",
			"[::1]",
			"",
			42,
			null,
		]);

		expect(ledgerHasHost("user-1", "example.com")).toBe(false);
		expect(ledgerHasHost("user-1", "https://example.com/a")).toBe(false);
	});

	it("forgets the least recently used host when a user's ledger is full", () => {
		recordLedgerHosts("user-1", ["first.example.com"]);
		for (let index = 0; index < LEDGER_MAX_HOSTS_PER_USER - 1; index += 1) {
			recordLedgerHosts("user-1", [`host-${index}.example.com`]);
		}
		expect(ledgerHasHost("user-1", "first.example.com")).toBe(true);

		// "first" was just used, so the next one to go is host-0.
		recordLedgerHosts("user-1", ["one-more.example.com"]);

		expect(ledgerHasHost("user-1", "first.example.com")).toBe(true);
		expect(ledgerHasHost("user-1", "host-0.example.com")).toBe(false);
		expect(ledgerHasHost("user-1", "one-more.example.com")).toBe(true);
	});

	it("forgets the least recently used user when too many users have a ledger", () => {
		for (let index = 0; index < LEDGER_MAX_USERS; index += 1) {
			recordLedgerHosts(`user-${index}`, ["example.com"]);
		}
		expect(ledgerHasHost("user-0", "example.com")).toBe(true);

		recordLedgerHosts("one-more-user", ["example.com"]);

		// user-0 was just used; user-1 is the oldest.
		expect(ledgerHasHost("user-0", "example.com")).toBe(true);
		expect(ledgerHasHost("user-1", "example.com")).toBe(false);
		expect(ledgerHasHost("one-more-user", "example.com")).toBe(true);
	});
});

describe("the source ledger: Brave thumbnails", () => {
	beforeEach(() => resetLedgerForTests());

	it("answers for the exact thumbnail address a search returned to this user", () => {
		recordLedgerThumbnails("user-1", [THUMB]);

		expect(ledgerHasThumbnail("user-1", THUMB)).toBe(true);
		expect(ledgerHasThumbnail("user-2", THUMB)).toBe(false);
	});

	it("does not answer for another address on Brave's image proxy, whatever it wraps", () => {
		recordLedgerThumbnails("user-1", [THUMB]);
		const forged = `${THUMB.slice(0, THUMB.lastIndexOf("/"))}/aHR0cHM6Ly9ldmlsLmV4YW1wbGUvP2Q9c2VjcmV0`;

		expect(ledgerHasThumbnail("user-1", forged)).toBe(false);
		expect(ledgerHasThumbnail("user-1", `${THUMB}?x=1`)).toBe(false);
	});

	it("remembers only addresses on Brave's image proxy", () => {
		recordLedgerThumbnails("user-1", [
			"https://example.com/cat.jpg",
			"http://imgs.search.brave.com/Zq3s9x/rs:fit:500:0:0:0/g:ce/abc",
			"https://imgs.search.brave.com:8443/Zq3s9x/abc",
			"https://evil.example/https://imgs.search.brave.com/abc",
			"not a url",
			null,
		]);

		expect(ledgerHasThumbnail("user-1", "https://example.com/cat.jpg")).toBe(
			false,
		);
		expect(
			ledgerHasThumbnail(
				"user-1",
				"http://imgs.search.brave.com/Zq3s9x/rs:fit:500:0:0:0/g:ce/abc",
			),
		).toBe(false);
	});

	it("forgets the least recently used thumbnail when a user's ledger is full", () => {
		const make = (index: number) =>
			`https://imgs.search.brave.com/sig/rs:fit:500:0:0:0/g:ce/${index}`;
		for (
			let index = 0;
			index < LEDGER_MAX_THUMBNAILS_PER_USER + 1;
			index += 1
		) {
			recordLedgerThumbnails("user-1", [make(index)]);
		}

		expect(ledgerHasThumbnail("user-1", make(0))).toBe(false);
		expect(ledgerHasThumbnail("user-1", make(1))).toBe(true);
		expect(
			ledgerHasThumbnail("user-1", make(LEDGER_MAX_THUMBNAILS_PER_USER)),
		).toBe(true);
	});
});
