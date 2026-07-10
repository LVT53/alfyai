import { describe, expect, it } from "vitest";
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

	// Task 9a — a new "tasks" capability served by two new providers:
	// Todoist (REST, API token) and generic CalDAV (VTODO, app-password).
	it("registers the tasks capability with todoist and caldav providers", () => {
		expect(CAPABILITY_META.tasks).toEqual({
			tier: "explicit",
			providers: ["todoist", "caldav"],
			displayName: "Tasks",
		});
		expect(PROVIDER_META.todoist).toEqual({
			capabilities: ["tasks"],
			connectMethod: "app-password",
			displayName: "Todoist",
		});
		expect(PROVIDER_META.caldav).toEqual({
			capabilities: ["tasks"],
			connectMethod: "app-password",
			displayName: "CalDAV",
		});
	});
});
