import { requireApiUser } from "$lib/server/api/auth";
import { completeBoschHostedSetup } from "$lib/server/services/connections/providers/bosch-flow-hosted";
import {
	callbackPath,
	callbackUrl,
	privateHeaders,
	stateCookie,
} from "../request";
import type { RequestHandler } from "./$types";

function settings(
	result:
		| "connected=bosch"
		| "error=bosch_oauth_denied"
		| "error=bosch_oauth_failed"
		| "error=bosch_oauth_invalid_state",
) {
	return new Response(null, {
		status: 303,
		headers: {
			...privateHeaders,
			location: `/settings?section=connections&${result}`,
		},
	});
}
export const GET: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const params = event.url.searchParams;
	const states = params.getAll("state");
	if (
		states.length !== 1 ||
		!states[0] ||
		states[0].length > 256 ||
		states[0] !== event.cookies.get(stateCookie)
	) {
		return settings("error=bosch_oauth_invalid_state");
	}
	const codes = params.getAll("code");
	const denied = params.has("error");
	if (!denied && (codes.length !== 1 || !codes[0] || codes[0].length > 4096))
		return settings("error=bosch_oauth_failed");

	event.cookies.delete(stateCookie, { path: callbackPath });
	if (denied) return settings("error=bosch_oauth_denied");
	try {
		await completeBoschHostedSetup(
			user.id,
			codes[0],
			states[0],
			callbackUrl(event.url),
		);
	} catch {
		return settings("error=bosch_oauth_failed");
	}
	return settings("connected=bosch");
};
