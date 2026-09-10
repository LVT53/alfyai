import { describe, expect, it } from "vitest";
import { CONNECTABLE_PROVIDER_LIST, PROVIDER_LIST } from "./provider-catalog";
import { connectWizardVariant, initialMailStep } from "./wizard-variant";

describe("connectWizardVariant", () => {
	it("hands the two OAuth providers to their own consent screens", () => {
		expect(connectWizardVariant("google")).toBe("oauth");
		expect(connectWizardVariant("onedrive")).toBe("oauth");
	});

	// OwnTracks is catalogued "password-key" but asks for nothing of the sort —
	// it picks a device off the recorder. The mapping must not follow the
	// connect method here.
	it("gives OwnTracks the device picker, not the password form", () => {
		expect(connectWizardVariant("owntracks")).toBe("owntracks");
	});

	it("gives each shared-connect-method provider its own screen", () => {
		expect(connectWizardVariant("immich")).toBe("immich");
		expect(connectWizardVariant("plex")).toBe("plex");
		expect(connectWizardVariant("github")).toBe("github");
		expect(connectWizardVariant("apple")).toBe("apple");
		expect(connectWizardVariant("caldav")).toBe("caldav");
	});

	it("gives Nextcloud and mail their multi-step flows", () => {
		expect(connectWizardVariant("nextcloud")).toBe("nextcloud");
		expect(connectWizardVariant("imap")).toBe("mail");
	});

	it("marks the resolver-only provider as not connectable on its own", () => {
		expect(connectWizardVariant("contacts")).toBe("unavailable");
	});

	it("has no variant at all when no provider is open", () => {
		expect(connectWizardVariant(null)).toBeNull();
	});

	// The wizard renders an exhaustive switch on this, so a provider added to
	// the catalogue without a screen must land on "unavailable" rather than an
	// empty dialog.
	it("resolves a variant for every provider in the catalogue", () => {
		for (const provider of PROVIDER_LIST) {
			expect(connectWizardVariant(provider), provider).not.toBeNull();
		}
	});

	it("never offers an 'unavailable' screen for a provider the add list shows", () => {
		for (const provider of CONNECTABLE_PROVIDER_LIST) {
			expect(connectWizardVariant(provider), provider).not.toBe("unavailable");
		}
	});
});

describe("initialMailStep", () => {
	it("asks where the mailbox lives on a fresh connect", () => {
		expect(initialMailStep(false)).toBe("choose");
	});

	// Reconnect keeps whatever host/port already worked: re-deriving them from
	// the address' domain would break any mailbox that needed a custom host.
	it("goes straight to the manual form on a reconnect", () => {
		expect(initialMailStep(true)).toBe("other");
	});
});
