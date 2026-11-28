import { error, json } from "@sveltejs/kit";
import { z } from "zod";
import { requireApiUser } from "$lib/server/api/auth";
import {
	listBoschBikesForNaming,
	nameBoschBike,
} from "$lib/server/services/connections/providers/bosch-flow-bridge";
import { privateHeaders, readSetupRequest } from "../hosted/request";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const bikes = await listBoschBikesForNaming(user.id);
	if (!bikes) error(503, "Bike list unavailable");
	return json({ bikes }, { headers: privateHeaders });
};

const rename = z
	.object({ id: z.string().min(1).max(150), name: z.string().trim().max(80) })
	.strict();
export const PATCH: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const { id, name } = await readSetupRequest(
		event.request,
		rename,
		event.url.origin,
	);
	if (!(await nameBoschBike(user.id, id, name)))
		error(409, "Bike list changed");
	return new Response(null, { status: 204, headers: privateHeaders });
};
