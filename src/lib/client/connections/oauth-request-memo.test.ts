import { beforeEach, describe, expect, it } from "vitest";
import {
	missingFromGrant,
	rememberRequestedCapabilities,
	takeRequestedCapabilities,
} from "./oauth-request-memo";

describe("oauth request memo", () => {
	beforeEach(() => {
		sessionStorage.clear();
	});

	it("carries the requested capabilities across the trip to the provider", () => {
		rememberRequestedCapabilities("google", ["calendar", "contacts"]);
		expect(takeRequestedCapabilities("google")).toEqual([
			"calendar",
			"contacts",
		]);
	});

	// Consuming it is the point: the notice is about the connect that just
	// happened, so revisiting the tab must not show it a second time.
	it("clears the memo once it has been read", () => {
		rememberRequestedCapabilities("google", ["calendar"]);
		takeRequestedCapabilities("google");
		expect(takeRequestedCapabilities("google")).toBeNull();
	});

	it("keeps each provider's memo separate", () => {
		rememberRequestedCapabilities("google", ["calendar"]);
		rememberRequestedCapabilities("onedrive", ["files"]);
		expect(takeRequestedCapabilities("onedrive")).toEqual(["files"]);
		expect(takeRequestedCapabilities("google")).toEqual(["calendar"]);
	});

	it("returns nothing when nothing was remembered", () => {
		expect(takeRequestedCapabilities("google")).toBeNull();
	});

	it("survives a corrupted memo without throwing", () => {
		sessionStorage.setItem("alfyai:connections:requested:google", "{not json");
		expect(takeRequestedCapabilities("google")).toBeNull();
	});
});

describe("missingFromGrant", () => {
	it("names what was asked for but not granted", () => {
		expect(missingFromGrant(["calendar", "contacts"], ["calendar"])).toEqual([
			"contacts",
		]);
	});

	it("is empty for a complete grant", () => {
		expect(
			missingFromGrant(["calendar", "contacts"], ["calendar", "contacts"]),
		).toEqual([]);
	});

	// No memo means no claim: a connect that happened in another tab must not
	// produce a "you were denied everything" notice.
	it("is empty when nothing was remembered", () => {
		expect(missingFromGrant(null, [])).toEqual([]);
	});
});
