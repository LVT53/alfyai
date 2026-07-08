import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	GoogleOAuthError,
	googleConnectStart,
} from "$lib/server/services/connections/providers/google";
import {
	CAPABILITIES,
	type Capability,
} from "$lib/server/services/connections/registry";
import type { RequestHandler } from "./$types";

function isCapability(value: unknown): value is Capability {
	return (
		typeof value === "string" &&
		(CAPABILITIES as readonly string[]).includes(value)
	);
}

// POST /api/connections/google/start — the client calls this to get the
// Google consent-screen URL to redirect to; the actual OAuth exchange
// happens in the callback route above.
export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;

	let body: { capabilities?: unknown };
	try {
		body = await event.request.json();
	} catch {
		return json({ error: "Invalid JSON" }, { status: 400 });
	}

	const capabilities = Array.isArray(body.capabilities)
		? body.capabilities.filter(isCapability)
		: [];
	if (capabilities.length === 0) {
		return json(
			{ error: "capabilities must be a non-empty array of known capabilities" },
			{ status: 400 },
		);
	}

	try {
		const result = await googleConnectStart({
			userId: user.id,
			origin: event.url.origin,
			capabilities,
		});
		return json(result);
	} catch (err) {
		const status =
			err instanceof GoogleOAuthError && err.code === "not_configured"
				? 501
				: 502;
		return json(
			{
				error:
					err instanceof Error ? err.message : "Failed to start Google connect",
			},
			{ status },
		);
	}
};
