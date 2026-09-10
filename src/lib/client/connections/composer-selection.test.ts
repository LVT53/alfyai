import { beforeEach, describe, expect, it } from "vitest";
import type { ActiveCapabilitiesConnection } from "$lib/client/api/connections";
import {
	capabilitiesForSelection,
	isAccountOn,
	masterIsOn,
	needsAttention,
	persistDisabledIds,
	readDisabledIds,
	readyCount,
	toggleAccount,
	toggleMaster,
} from "./composer-selection";

function conn(
	overrides: Partial<ActiveCapabilitiesConnection> = {},
): ActiveCapabilitiesConnection {
	return {
		id: "c1",
		label: "Nextcloud",
		provider: "nextcloud",
		accountIdentifier: "cloud.example.com",
		status: "connected",
		defaultOn: true,
		capabilities: ["files", "contacts"],
		...overrides,
	};
}

const CONNECTIONS: ActiveCapabilitiesConnection[] = [
	conn({ id: "nc", capabilities: ["files", "contacts"] }),
	conn({
		id: "mail",
		provider: "imap",
		label: "Email",
		capabilities: ["email"],
	}),
	conn({
		id: "gh",
		provider: "github",
		label: "GitHub",
		status: "needs_reauth",
		capabilities: [],
	}),
];

// The settings dialog's own words for "Use it without asking": "Off, it only
// uses {provider} when you turn connections on for that message." So an
// account with defaultOn=false must start OFF in the composer, and the
// per-conversation choice is a deviation from that setting, never a
// replacement for it.
describe('the account\'s own "Use it without asking" setting', () => {
	const askFirst = conn({
		id: "mail",
		defaultOn: false,
		capabilities: ["email"],
	});
	const automatic = conn({
		id: "nc",
		defaultOn: true,
		capabilities: ["files"],
	});

	it("starts an ask-first account off and an automatic one on", () => {
		expect(isAccountOn(automatic, new Set())).toBe(true);
		expect(isAccountOn(askFirst, new Set())).toBe(false);
	});

	it("keeps an ask-first account's capabilities off the wire by default", () => {
		expect(capabilitiesForSelection([automatic, askFirst], new Set())).toEqual([
			"files",
		]);
	});

	it("sends an ask-first account only once it is turned on for this message", () => {
		const on = toggleAccount(new Set(), "mail");
		expect(capabilitiesForSelection([automatic, askFirst], on).sort()).toEqual([
			"email",
			"files",
		]);
	});

	it("counts an ask-first account as off until it is turned on", () => {
		expect(readyCount([automatic, askFirst], new Set())).toEqual({
			on: 1,
			total: 2,
		});
	});

	it("turns everything on and back to each account's own setting", () => {
		const both = [automatic, askFirst];
		const allOn = toggleMaster(both, toggleMaster(both, new Set()));
		expect(capabilitiesForSelection(both, allOn).sort()).toEqual([
			"email",
			"files",
		]);
		const allOff = toggleMaster(both, allOn);
		expect(capabilitiesForSelection(both, allOff)).toEqual([]);
	});
});

describe("capabilitiesForSelection", () => {
	it("sends every ready account's capabilities when nothing is left out", () => {
		expect(capabilitiesForSelection(CONNECTIONS, new Set()).sort()).toEqual([
			"contacts",
			"email",
			"files",
		]);
	});

	// The whole point of the per-account list: leave one out of this
	// conversation without disconnecting it everywhere.
	it("drops one account's capabilities without touching the rest", () => {
		expect(capabilitiesForSelection(CONNECTIONS, new Set(["nc"]))).toEqual([
			"email",
		]);
	});

	it("sends nothing when every account is left out", () => {
		expect(
			capabilitiesForSelection(CONNECTIONS, new Set(["nc", "mail", "gh"])),
		).toEqual([]);
	});

	// A broken account contributes nothing whether or not it is switched on —
	// the server would refuse it anyway, and offering it would be a lie.
	it("ignores an account that isn't ready", () => {
		expect(capabilitiesForSelection([CONNECTIONS[2]], new Set())).toEqual([]);
	});

	it("does not double-count a capability two accounts both serve", () => {
		const both = [
			conn({ id: "a", capabilities: ["calendar"] }),
			conn({ id: "b", provider: "apple", capabilities: ["calendar"] }),
		];
		expect(capabilitiesForSelection(both, new Set())).toEqual(["calendar"]);
	});
});

describe("readyCount", () => {
	it("counts the ready accounts that are on, against every account there is", () => {
		expect(readyCount(CONNECTIONS, new Set())).toEqual({ on: 2, total: 3 });
		expect(readyCount(CONNECTIONS, new Set(["nc"]))).toEqual({
			on: 1,
			total: 3,
		});
	});
});

describe("needsAttention", () => {
	it("names the accounts that are broken, not the ones merely switched off", () => {
		expect(needsAttention(CONNECTIONS).map((c) => c.id)).toEqual(["gh"]);
		expect(
			needsAttention([conn({ id: "off", status: "disconnected" })]),
		).toEqual([]);
	});
});

describe("the master switch", () => {
	it("is on while any ready account is on", () => {
		expect(masterIsOn(CONNECTIONS, new Set())).toBe(true);
		expect(masterIsOn(CONNECTIONS, new Set(["nc"]))).toBe(true);
		expect(masterIsOn(CONNECTIONS, new Set(["nc", "mail"]))).toBe(false);
	});

	it("silences everything when switched off, and restores everything when switched on", () => {
		const allOff = toggleMaster(CONNECTIONS, new Set());
		expect(capabilitiesForSelection(CONNECTIONS, allOff)).toEqual([]);
		const backOn = toggleMaster(CONNECTIONS, allOff);
		expect(backOn.size).toBe(0);
		expect(capabilitiesForSelection(CONNECTIONS, backOn).sort()).toEqual([
			"contacts",
			"email",
			"files",
		]);
	});
});

describe("toggleAccount", () => {
	it("switches one account off and back on", () => {
		const off = toggleAccount(new Set(), "nc");
		expect([...off]).toEqual(["nc"]);
		expect([...toggleAccount(off, "nc")]).toEqual([]);
	});
});

describe("per-conversation memory", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("remembers what was left out, per conversation", () => {
		persistDisabledIds("conv-1", new Set(["gh"]));
		expect([...readDisabledIds("conv-1")]).toEqual(["gh"]);
		expect([...readDisabledIds("conv-2")]).toEqual([]);
	});

	it("forgets rather than storing an empty choice", () => {
		persistDisabledIds("conv-1", new Set(["gh"]));
		persistDisabledIds("conv-1", new Set());
		expect(
			localStorage.getItem("alfyai:composer:connectionsOff:conv-1"),
		).toBeNull();
	});

	// Storing what was LEFT OUT (rather than what was picked) means a
	// connection added later is included by default, instead of silently
	// missing from every conversation that predates it.
	it("includes an account added after the choice was made", () => {
		persistDisabledIds("conv-1", new Set(["gh"]));
		const later = [
			...CONNECTIONS,
			conn({ id: "new", capabilities: ["photos"] }),
		];
		expect(
			capabilitiesForSelection(later, readDisabledIds("conv-1")),
		).toContain("photos");
	});

	it("survives a corrupted entry", () => {
		localStorage.setItem("alfyai:composer:connectionsOff:conv-1", "{not json");
		expect([...readDisabledIds("conv-1")]).toEqual([]);
	});
});
