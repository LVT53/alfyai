import { describe, expect, it } from "vitest";
import {
	CONNECTABLE_PROVIDER_LIST,
	groupConnectableProviders,
	isKnownProvider,
	PROVIDER_CATALOG,
	PROVIDER_LIST,
} from "./provider-catalog";

describe("groupConnectableProviders", () => {
	it("splits connectable providers into product and custom groups", () => {
		const { product, custom } = groupConnectableProviders();
		expect(product).toEqual([
			"nextcloud",
			"immich",
			"imap",
			"google",
			"apple",
			"plex",
			"owntracks",
			"github",
			"onedrive",
		]);
		expect(custom).toEqual(["caldav"]);
	});

	it("preserves CONNECTABLE_PROVIDER_LIST ordering within each group", () => {
		const { product, custom } = groupConnectableProviders();
		const recombined = [...product, ...custom];
		// Every grouped provider appears in the same relative order it has in
		// the source list (products first because they lead PROVIDER_CATALOG's
		// declaration order, custom last).
		const sourceOrder = CONNECTABLE_PROVIDER_LIST.filter((p) =>
			recombined.includes(p),
		);
		expect(product).toEqual(
			sourceOrder.filter((p) => PROVIDER_CATALOG[p].group === "product"),
		);
		expect(custom).toEqual(
			sourceOrder.filter((p) => PROVIDER_CATALOG[p].group === "custom"),
		);
	});

	it("covers exactly the connectable providers, nothing more", () => {
		const { product, custom } = groupConnectableProviders();
		expect([...product, ...custom].sort()).toEqual(
			[...CONNECTABLE_PROVIDER_LIST].sort(),
		);
	});

	it("excludes the resolver-only 'contacts' provider (not connectable)", () => {
		const { product, custom } = groupConnectableProviders();
		expect(product).not.toContain("contacts");
		expect(custom).not.toContain("contacts");
		// contacts is still catalogued and tagged custom, just not connectable.
		expect(PROVIDER_CATALOG.contacts.connectable).toBe(false);
		expect(PROVIDER_CATALOG.contacts.group).toBe("custom");
	});

	it("never includes retired Todoist anywhere", () => {
		const { product, custom } = groupConnectableProviders();
		expect(product).not.toContain("todoist");
		expect(custom).not.toContain("todoist");
		expect(isKnownProvider("todoist")).toBe(false);
	});

	it("tags every catalogued provider with a valid group", () => {
		for (const provider of PROVIDER_LIST) {
			expect(["product", "custom"]).toContain(PROVIDER_CATALOG[provider].group);
		}
	});
});
