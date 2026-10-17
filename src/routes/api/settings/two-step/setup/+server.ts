import { json } from "@sveltejs/kit";
import { secondFactorFailureResponse } from "$lib/server/api/second-factor";
import { requireAuth } from "$lib/server/auth/hooks";
import { beginTwoStepSetup } from "$lib/server/services/two-step";
import type { RequestHandler } from "./$types";

/**
 * Starts (or restarts) setup: a fresh secret, its QR and the typed key. The
 * key and the QR are the only secret this route ever returns, and only to the
 * signed-in account that asked for its own setup (spec §5.4).
 *
 * R13: an existing unconfirmed factor is replaced; a confirmed one answers
 * 409 `already_on`, never an overwrite of a working factor.
 */
export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;

	// The phone fetches the mark, so it has to be absolute; `event.url.origin`
	// is the public origin SvelteKit sees behind the proxy.
	const result = await beginTwoStepSetup(
		user.id,
		user.email,
		`${event.url.origin}/icon-192.png`,
	);
	if (!result.ok) return secondFactorFailureResponse(result.reason);

	return json({ qrSvg: result.qrSvg, key: result.key });
};
