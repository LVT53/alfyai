import { describe, expect, it } from "vitest";
import { isKnownProvider } from "$lib/client/connections/provider-catalog";
import type { ConnectionProvider } from "$lib/server/db/schema";
import { CONNECTION_PROVIDERS } from "$lib/server/db/schema";
import {
	CAPABILITIES,
	CAPABILITY_META,
	type ConnectMethod,
	PROVIDER_META,
} from "./registry";

const CONNECT_METHODS: readonly ConnectMethod[] = [
	"oauth",
	"login-flow-v2",
	"password-key",
	"app-password",
];

describe("connections registry", () => {
	it("is bidirectionally consistent: provider -> capability -> provider", () => {
		for (const provider of CONNECTION_PROVIDERS) {
			const meta = PROVIDER_META[provider];
			for (const capability of meta.capabilities) {
				expect(CAPABILITY_META[capability].providers).toContain(provider);
			}
		}
	});

	it("is bidirectionally consistent: capability -> provider -> capability", () => {
		for (const capability of CAPABILITIES) {
			const meta = CAPABILITY_META[capability];
			for (const provider of meta.providers) {
				expect(
					PROVIDER_META[provider as ConnectionProvider].capabilities,
				).toContain(capability);
			}
		}
	});

	it("has a CAPABILITY_META entry with at least one provider for every Capability", () => {
		for (const capability of CAPABILITIES) {
			const meta = CAPABILITY_META[capability];
			expect(meta).toBeDefined();
			expect(meta.providers.length).toBeGreaterThan(0);
		}
	});

	it("has a PROVIDER_META entry for every ConnectionProvider", () => {
		for (const provider of CONNECTION_PROVIDERS) {
			expect(PROVIDER_META[provider]).toBeDefined();
		}
	});

	it("marks exactly calendar and email as proactive tier", () => {
		const proactive = CAPABILITIES.filter(
			(c) => CAPABILITY_META[c].tier === "proactive",
		).sort();
		expect(proactive).toEqual(["calendar", "email"]);
	});

	it("marks all other capabilities as explicit tier", () => {
		const explicit = CAPABILITIES.filter(
			(c) => CAPABILITY_META[c].tier === "explicit",
		).sort();
		expect(explicit).toEqual(
			[
				"contacts",
				"files",
				"location",
				"media",
				"photos",
				"repos",
				"tasks",
			].sort(),
		);
	});

	it("uses only valid ConnectMethod values", () => {
		for (const provider of CONNECTION_PROVIDERS) {
			expect(CONNECT_METHODS).toContain(PROVIDER_META[provider].connectMethod);
		}
	});

	// Task 8 — OneDrive is a second provider under the existing "files"
	// capability (alongside nextcloud), connected via OAuth like Google.
	it("registers onedrive as an oauth files provider alongside nextcloud", () => {
		expect(PROVIDER_META.onedrive).toEqual({
			capabilities: ["files"],
			connectMethod: "oauth",
			displayName: "OneDrive",
		});
		expect(CAPABILITY_META.files.providers).toContain("onedrive");
		expect(CAPABILITY_META.files.providers).toContain("nextcloud");
	});

	// Slice A1 — Todoist is fully retired. The "tasks" capability is now served
	// by CalDAV only; "todoist" must not survive anywhere in the product.
	it("serves the tasks capability with caldav only — todoist is fully retired", () => {
		expect(CAPABILITY_META.tasks).toEqual({
			tier: "explicit",
			providers: ["caldav"],
			displayName: "Tasks",
		});
		expect(CAPABILITY_META.tasks.providers).not.toContain("todoist");
		expect(isKnownProvider("todoist")).toBe(false);
		expect(CONNECTION_PROVIDERS).not.toContain("todoist" as ConnectionProvider);
		expect("todoist" in PROVIDER_META).toBe(false);
	});

	// Task 9b — generalizes the "caldav" provider from tasks-only (9a) to also
	// serve calendar (VEVENT) and contacts (CardDAV vCard), so it works for any
	// standards-compliant CalDAV/CardDAV server, not just Apple iCloud.
	it("widens the caldav provider to tasks + calendar + contacts, and lists it under all three capabilities", () => {
		expect(PROVIDER_META.caldav).toEqual({
			capabilities: ["tasks", "calendar", "contacts"],
			connectMethod: "app-password",
			displayName: "CalDAV",
		});
		expect(CAPABILITY_META.calendar.providers).toContain("caldav");
		expect(CAPABILITY_META.contacts.providers).toContain("caldav");
		expect(CAPABILITY_META.tasks.providers).toContain("caldav");
		// Apple's own providers stay exactly as they were — this is additive,
		// not a replacement of the existing google/apple calendar+contacts
		// providers.
		expect(CAPABILITY_META.calendar.providers).toEqual([
			"google",
			"apple",
			"caldav",
		]);
		expect(CAPABILITY_META.contacts.providers).toEqual([
			"google",
			"apple",
			"nextcloud",
			"contacts",
			"caldav",
		]);
	});
});
