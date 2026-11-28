import { error, json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import {
	getBoschHostedSetup,
	setBoschHostedGrants,
	startBoschHostedSetup,
} from "$lib/server/services/connections/providers/bosch-flow-hosted";
import { boschRejectsCallback } from "$lib/server/services/connections/providers/bosch-flow-oauth";
import {
	boschHostedPermissionsSchema,
	boschHostedStartSchema,
} from "$lib/shared/bosch-hosted";
import type { RequestHandler } from "./$types";
import {
	callbackPath,
	callbackUrl,
	privateHeaders,
	readSetupRequest,
	stateCookie,
} from "./request";

export const GET: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const { mode, grants } = await getBoschHostedSetup(user.id);
	return json(
		{ mode, grants, callbackUrl: callbackUrl(event.url).href },
		{ headers: privateHeaders },
	);
};

export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const body = await readSetupRequest(
		event.request,
		boschHostedStartSchema,
		event.url.origin,
	);
	const callback = callbackUrl(event.url);
	if (await boschRejectsCallback(body.clientId, callback))
		error(422, "Register the displayed Redirect URI for this Bosch client");
	const { url, state } = await startBoschHostedSetup(user.id, body, callback);
	event.cookies.set(stateCookie, state, {
		path: callbackPath,
		httpOnly: true,
		secure: callback.protocol === "https:",
		sameSite: "lax",
		maxAge: 600,
	});
	return json({ authUrl: url }, { headers: privateHeaders });
};

export const PATCH: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const { grants } = await readSetupRequest(
		event.request,
		boschHostedPermissionsSchema,
		event.url.origin,
	);
	if (!(await setBoschHostedGrants(user.id, grants)))
		error(409, "Connect Bosch before saving permissions");
	return new Response(null, { status: 204, headers: privateHeaders });
};
