import { error, json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import {
	BoschPairingConflict,
	pairBoschBridge,
} from "$lib/server/services/connections/providers/bosch-flow-bridge";
import type { RequestHandler } from "./$types";
export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	try {
		return json(await pairBoschBridge(user.id), {
			headers: { "Cache-Control": "no-store" },
		});
	} catch (cause) {
		if (cause instanceof BoschPairingConflict)
			throw error(409, "Pairing changed. Try again.");
		throw cause;
	}
};
