import { describe, expect, it, vi } from "vitest";
import {
	CONNECTION_PROVIDERS,
	type ConnectionProvider,
} from "$lib/server/db/schema";

// Pins that loading the health-check path ALONE registers every provider's
// ConnectionAdapter. Provider adapters register as a side effect of their
// module being evaluated, and SvelteKit loads each route module lazily on its
// first request — so POST /api/connections/[id]/recheck, which imports only
// health.ts, can be the first thing a fresh server process runs. If health.ts
// did not pull the providers in itself, that recheck would find an empty
// registry and persist "No adapter registered" onto a working connection.
//
// No registry reset and no direct provider import here on purpose: the only
// thing allowed to populate the registry is importing ./health.

// "contacts" is a capability-shaped provider id with no connect flow and no
// adapter of its own (see providers/contacts.ts); every other provider must
// resolve.
const PROVIDERS_WITHOUT_ADAPTER = new Set<ConnectionProvider>(["contacts"]);

describe("connection health adapter registration", () => {
	it("resolves an adapter for every connectable provider from a fresh module registry", async () => {
		vi.resetModules();
		await import("./health");
		const { getConnectionAdapter } = await import("./adapters");

		const missing = CONNECTION_PROVIDERS.filter(
			(provider) =>
				!PROVIDERS_WITHOUT_ADAPTER.has(provider) &&
				getConnectionAdapter(provider) === null,
		);
		expect(missing).toEqual([]);
	});
});
