import { describe, expect, it } from "vitest";
import { grantedCapabilitiesFor } from "./granted";
import { OAUTH_CAPABILITY_SCOPES } from "./registry";

const GOOGLE_CALENDAR = OAUTH_CAPABILITY_SCOPES.google?.calendar as string;
const GOOGLE_CONTACTS = OAUTH_CAPABILITY_SCOPES.google?.contacts as string;
const ONEDRIVE_FILES = OAUTH_CAPABILITY_SCOPES.onedrive?.files as string;

describe("grantedCapabilitiesFor", () => {
	it("derives an OAuth provider's grant from the scopes it came back with", () => {
		expect(
			grantedCapabilitiesFor({
				provider: "google",
				oauthScopes: ["openid", GOOGLE_CALENDAR, GOOGLE_CONTACTS],
				capabilities: ["calendar", "contacts"],
				config: {},
			}),
		).toEqual(["calendar", "contacts"]);
	});

	// The case the whole feature exists for: the user ticked both boxes, Google
	// only handed back Calendar. The connection must report Contacts as NOT
	// granted even though the catalogue lists it.
	it("omits a capability the OAuth provider denied", () => {
		expect(
			grantedCapabilitiesFor({
				provider: "google",
				oauthScopes: ["openid", GOOGLE_CALENDAR],
				capabilities: ["calendar"],
				config: {},
			}),
		).toEqual(["calendar"]);
	});

	// A capability the user somehow has switched on without a scope behind it
	// still reports as not granted — `capabilities` never widens the grant.
	it("does not let an enabled capability imply a grant for an OAuth provider", () => {
		expect(
			grantedCapabilitiesFor({
				provider: "google",
				oauthScopes: [GOOGLE_CALENDAR],
				capabilities: ["calendar", "contacts"],
				config: {},
			}),
		).toEqual(["calendar"]);
	});

	it("returns nothing for an OAuth connection with no scopes at all", () => {
		expect(
			grantedCapabilitiesFor({
				provider: "onedrive",
				oauthScopes: [],
				capabilities: [],
				config: {},
			}),
		).toEqual([]);
	});

	it("derives OneDrive's grant from its own scope", () => {
		expect(
			grantedCapabilitiesFor({
				provider: "onedrive",
				oauthScopes: ["openid", ONEDRIVE_FILES],
				capabilities: ["files"],
				config: {},
			}),
		).toEqual(["files"]);
	});

	it("derives a CalDAV connection's grant from what discovery found", () => {
		expect(
			grantedCapabilitiesFor({
				provider: "caldav",
				oauthScopes: [],
				capabilities: ["calendar"],
				config: {
					calendarUrls: ["https://dav.example.com/cal/"],
					taskListUrls: [],
					addressbookUrls: [],
				},
			}),
		).toEqual(["calendar"]);
	});

	// A legacy row predating discovery tells us nothing about what the server
	// offers, so nothing may be reported as denied. Deriving the grant from
	// the ENABLED list instead would be a one-way door: switching Contacts off
	// would replace its switch with a greyed "not allowed / Look again" line
	// and there would be no way back on.
	it("claims no denial for a legacy CalDAV row with no discovery config", () => {
		expect(
			grantedCapabilitiesFor({
				provider: "caldav",
				oauthScopes: [],
				capabilities: ["tasks"],
				config: {},
			}),
		).toEqual(["tasks", "calendar", "contacts"]);
	});

	it("does not shrink a legacy CalDAV row's grant when a capability is switched off", () => {
		const legacy = {
			provider: "caldav" as const,
			oauthScopes: [],
			config: {},
		};
		expect(
			grantedCapabilitiesFor({ ...legacy, capabilities: ["calendar"] }),
		).toEqual(grantedCapabilitiesFor({ ...legacy, capabilities: [] }));
	});

	it("grants an account-wide provider its whole catalogue", () => {
		expect(
			grantedCapabilitiesFor({
				provider: "nextcloud",
				oauthScopes: [],
				capabilities: ["files"],
				config: {},
			}),
		).toEqual(["files", "contacts"]);
	});
});
