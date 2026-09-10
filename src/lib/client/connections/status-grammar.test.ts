import { describe, expect, it } from "vitest";
import type { ConnectionPublic } from "$lib/client/api/connections";
import {
	capabilityChipsOf,
	connectionStatusGrammar,
	deniedCapabilitiesOf,
	grantedCapabilitiesOf,
	makeGrammarFormatters,
} from "./status-grammar";

// Fixed formatters so a test asserts the SHAPE of the sentence (which key,
// which timestamp fed which formatter) rather than a locale's phrasing.
const formatters = {
	relative: (at: number) => `relative(${at})`,
	date: (at: number) => `date(${at})`,
	dateTime: (at: number) => `dateTime(${at})`,
};

function makeConnection(
	overrides: Partial<ConnectionPublic> = {},
): ConnectionPublic {
	return {
		id: "conn-1",
		provider: "google",
		label: "Google",
		accountIdentifier: "person@example.com",
		status: "connected",
		statusDetail: null,
		defaultOn: true,
		allowWrites: false,
		writeAllowlist: [],
		capabilities: ["calendar"],
		grantedCapabilities: ["calendar", "contacts"],
		config: {},
		oauthScopes: [],
		tokenExpiresAt: null,
		hasSecret: true,
		hasWriteSecret: false,
		lastUsedAt: null,
		statusChangedAt: null,
		createdAt: 1_756_000_000,
		updatedAt: 1_756_000_000,
		...overrides,
	};
}

describe("connectionStatusGrammar", () => {
	it("gives a healthy connection a word and a sentence, not silence", () => {
		const grammar = connectionStatusGrammar(
			makeConnection({ status: "connected", lastUsedAt: 1_757_000_000 }),
			formatters,
		);
		expect(grammar.tone).toBe("ok");
		expect(grammar.word).toBe("connections.status.connected");
		expect(grammar.sentence).toBe("connections.status.sentence.lastUsed");
		expect(grammar.sentenceParams.when).toBe("relative(1757000000)");
		expect(grammar.recovery).toBeNull();
	});

	it("falls back to the connect date when a healthy connection has never been used", () => {
		const grammar = connectionStatusGrammar(
			makeConnection({ status: "connected", lastUsedAt: null }),
			formatters,
		);
		expect(grammar.sentence).toBe(
			"connections.status.sentence.readyNotUsedYet",
		);
		expect(grammar.sentenceParams.when).toBe("date(1756000000)");
	});

	it("names the provider and the day a saved permission stopped working", () => {
		const grammar = connectionStatusGrammar(
			makeConnection({
				status: "needs_reauth",
				statusChangedAt: 1_757_300_000,
			}),
			formatters,
		);
		expect(grammar.tone).toBe("warn");
		expect(grammar.word).toBe("connections.status.needsSignIn");
		expect(grammar.sentence).toBe("connections.status.sentence.needsSignInOn");
		expect(grammar.sentenceParams).toEqual({
			provider: "Google",
			when: "date(1757300000)",
		});
		expect(grammar.recovery).toEqual({
			kind: "signIn",
			label: "connections.actions.signInAgain",
		});
	});

	it("drops the date rather than inventing one when the status has never changed", () => {
		const grammar = connectionStatusGrammar(
			makeConnection({ status: "needs_reauth", statusChangedAt: null }),
			formatters,
		);
		expect(grammar.sentence).toBe("connections.status.sentence.needsSignIn");
		expect(grammar.sentenceParams).toEqual({ provider: "Google" });
	});

	it("uses a precise time for an error, since it has to be correlated with something", () => {
		const grammar = connectionStatusGrammar(
			makeConnection({
				provider: "github",
				status: "error",
				statusChangedAt: 1_757_400_000,
				statusDetail: "401 Bad credentials",
			}),
			formatters,
		);
		expect(grammar.tone).toBe("danger");
		expect(grammar.word).toBe("connections.status.unreachable");
		expect(grammar.sentence).toBe("connections.status.sentence.unreachableAt");
		expect(grammar.sentenceParams).toEqual({
			provider: "GitHub",
			when: "dateTime(1757400000)",
		});
		expect(grammar.recovery?.kind).toBe("fix");
	});

	// The provider's own error string is backend phrasing. It stays available
	// but never becomes the sentence the user reads first.
	it("keeps the provider's raw error out of the sentence and in technicalDetail", () => {
		const grammar = connectionStatusGrammar(
			makeConnection({
				status: "error",
				statusDetail: "  ECONNREFUSED 10.0.0.4:443  ",
			}),
			formatters,
		);
		expect(grammar.technicalDetail).toBe("ECONNREFUSED 10.0.0.4:443");
		expect(Object.values(grammar.sentenceParams)).not.toContain(
			"ECONNREFUSED 10.0.0.4:443",
		);
	});

	it("treats a blank status detail as no detail at all", () => {
		const grammar = connectionStatusGrammar(
			makeConnection({ status: "error", statusDetail: "   " }),
			formatters,
		);
		expect(grammar.technicalDetail).toBeNull();
	});

	it("offers a way back from a turned-off connection", () => {
		const grammar = connectionStatusGrammar(
			makeConnection({
				status: "disconnected",
				statusChangedAt: 1_756_800_000,
			}),
			formatters,
		);
		expect(grammar.tone).toBe("muted");
		expect(grammar.word).toBe("connections.status.turnedOff");
		expect(grammar.sentence).toBe("connections.status.sentence.turnedOffOn");
		expect(grammar.recovery).toEqual({
			kind: "connectAgain",
			label: "connections.actions.connectAgain",
		});
	});

	it("still describes a provider the client catalogue has never heard of", () => {
		const grammar = connectionStatusGrammar(
			makeConnection({ provider: "someday-cloud", status: "needs_reauth" }),
			formatters,
		);
		expect(grammar.sentenceParams.provider).toBe("someday-cloud");
	});
});

describe("makeGrammarFormatters", () => {
	const NOW = Date.parse("2026-09-10T12:00:00Z");

	it("says how long ago something was, in words, in English", () => {
		const f = makeGrammarFormatters("en", () => NOW);
		expect(f.relative((NOW - 12 * 60 * 1000) / 1000)).toMatch(/12 minutes ago/);
		expect(f.relative((NOW - 26 * 3600 * 1000) / 1000)).toMatch(/yesterday/i);
	});

	it("says it in Hungarian too, rather than falling back to English", () => {
		const f = makeGrammarFormatters("hu", () => NOW);
		expect(f.relative((NOW - 12 * 60 * 1000) / 1000)).toMatch(/perc/);
	});

	// Beyond a month "34 days ago" stops being useful and a date is clearer.
	it("switches from a relative phrase to a date once something is old", () => {
		const f = makeGrammarFormatters("en", () => NOW);
		expect(f.relative((NOW - 90 * 86400 * 1000) / 1000)).not.toMatch(/ago/);
	});
});

describe("granted vs enabled capabilities", () => {
	it("reports the capabilities the provider refused", () => {
		const conn = makeConnection({
			provider: "google",
			grantedCapabilities: ["calendar"],
			capabilities: ["calendar"],
		});
		expect(grantedCapabilitiesOf(conn)).toEqual(["calendar"]);
		expect(deniedCapabilitiesOf(conn)).toEqual(["contacts"]);
	});

	// An older server (or a fixture) that doesn't send the field must not make
	// every capability look denied.
	it("assumes the whole catalogue was granted when the server didn't say", () => {
		const conn = makeConnection({ grantedCapabilities: undefined });
		expect(grantedCapabilitiesOf(conn)).toEqual(["calendar", "contacts"]);
		expect(deniedCapabilitiesOf(conn)).toEqual([]);
	});

	it("ignores a granted capability the provider's catalogue doesn't have", () => {
		const conn = makeConnection({
			provider: "plex",
			grantedCapabilities: ["media", "email"],
		});
		expect(grantedCapabilitiesOf(conn)).toEqual(["media"]);
	});
});

describe("capabilityChipsOf", () => {
	it("tells a switched-off capability apart from a denied one", () => {
		const chips = capabilityChipsOf(
			makeConnection({
				provider: "google",
				capabilities: [],
				grantedCapabilities: ["calendar"],
			}),
		);
		expect(chips).toEqual([
			{ kind: "capability", capability: "calendar", state: "off" },
			{ kind: "capability", capability: "contacts", state: "denied" },
		]);
	});

	it("marks an enabled, granted capability as on", () => {
		const chips = capabilityChipsOf(
			makeConnection({
				capabilities: ["calendar", "contacts"],
				grantedCapabilities: ["calendar", "contacts"],
			}),
		);
		expect(chips.every((chip) => chip.kind === "capability")).toBe(true);
		expect(chips.map((chip) => "state" in chip && chip.state)).toEqual([
			"on",
			"on",
		]);
	});

	it("says how many folders a path-scoped writable connection may write to", () => {
		const chips = capabilityChipsOf(
			makeConnection({
				provider: "nextcloud",
				capabilities: ["files", "contacts"],
				grantedCapabilities: ["files", "contacts"],
				allowWrites: true,
				writeAllowlist: ["/AlfyAI", "/Documents/Reports"],
			}),
		);
		expect(chips.at(-1)).toEqual({
			kind: "writes",
			variant: "folders",
			folderCount: 2,
		});
	});

	it("calls a mailbox's writes drafts", () => {
		const chips = capabilityChipsOf(
			makeConnection({
				provider: "imap",
				capabilities: ["email"],
				grantedCapabilities: ["email"],
				allowWrites: true,
			}),
		);
		expect(chips.at(-1)).toEqual({ kind: "writes", variant: "drafts" });
	});

	it("adds no write chip when writes are off, or when the provider can't write", () => {
		expect(
			capabilityChipsOf(
				makeConnection({
					provider: "nextcloud",
					allowWrites: false,
					grantedCapabilities: ["files", "contacts"],
				}),
			).some((chip) => chip.kind === "writes"),
		).toBe(false);
		expect(
			capabilityChipsOf(
				makeConnection({
					provider: "plex",
					capabilities: ["media"],
					grantedCapabilities: ["media"],
					allowWrites: true,
				}),
			).some((chip) => chip.kind === "writes"),
		).toBe(false);
	});
});
