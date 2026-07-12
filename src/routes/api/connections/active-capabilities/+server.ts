import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import { CAPABILITIES } from "$lib/server/services/connections/registry";
import {
	getDefaultOnCapabilities,
	getEnabledConnectionCapabilities,
	resolveConnectionsForCapability,
} from "$lib/server/services/connections/resolve";
import type { RequestHandler } from "./$types";

// GET /api/connections/active-capabilities — feeds the chat composer
// (Issue 7.2). Returns, for the authenticated caller only:
//   - served: capabilities the user has at least one connected connection
//     serving (same predicate as getEnabledConnectionCapabilities).
//   - defaultOn: the subset of `served` with defaultOn=true on a serving
//     connection — the set the composer initializes its toggles to.
//   - accounts: per served capability, the connections serving it (id/label/
//     provider only, no secrets) so the composer can render the multi-account
//     indicator when more than one connection serves a capability.
export const GET: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const userId = user.id;

	const [served, defaultOn] = await Promise.all([
		getEnabledConnectionCapabilities(userId),
		getDefaultOnCapabilities(userId),
	]);

	const orderedServed = CAPABILITIES.filter((capability) =>
		served.has(capability),
	);

	const accounts = await Promise.all(
		orderedServed.map(async (capability) => {
			const connections = await resolveConnectionsForCapability(
				userId,
				capability,
			);
			return {
				capability,
				connections: connections.map((conn) => ({
					id: conn.id,
					label: conn.label,
					provider: conn.provider,
				})),
			};
		}),
	);

	return json({
		served: orderedServed,
		defaultOn: CAPABILITIES.filter((capability) => defaultOn.has(capability)),
		accounts,
	});
};
