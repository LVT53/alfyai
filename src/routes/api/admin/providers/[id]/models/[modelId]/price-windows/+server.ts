import { json } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/auth/hooks";
import {
	isPriceWindowValidationError,
	listPriceWindows,
	parsePriceWindowsPayload,
	replacePriceWindowsForModel,
} from "$lib/server/services/price-windows";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	try {
		requireAdmin(event);
		const { modelId } = event.params;
		const windows = await listPriceWindows(modelId);
		return json({ windows });
	} catch (error) {
		console.error("[ADMIN] Failed to list price windows:", error);
		return json({ error: "Failed to list price windows" }, { status: 500 });
	}
};

// Replace the model's entire price-window set. The admin form manages the list
// client-side and saves it wholesale, so a single atomic replace is the cleanest
// contract (validated + transactional in the service).
export const PUT: RequestHandler = async (event) => {
	try {
		requireAdmin(event);
		const { modelId } = event.params;

		let body: unknown;
		try {
			body = await event.request.json();
		} catch {
			return json({ error: "Invalid JSON" }, { status: 400 });
		}

		const inputs = parsePriceWindowsPayload(body);
		const windows = await replacePriceWindowsForModel(modelId, inputs);
		return json({ windows });
	} catch (error) {
		if (isPriceWindowValidationError(error)) {
			return json({ error: error.message }, { status: 400 });
		}
		console.error("[ADMIN] Failed to save price windows:", error);
		return json({ error: "Failed to save price windows" }, { status: 500 });
	}
};
