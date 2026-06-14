import { json } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/auth/hooks";
import {
	deleteProviderModel,
	updateProviderModelFromPayload,
} from "$lib/server/services/provider-models";
import { isProviderModelValidationError } from "../provider-model-route-errors";
import type { RequestHandler } from "./$types";

export const PUT: RequestHandler = async (event) => {
	try {
		requireAdmin(event);
		const { modelId } = event.params;

		let body: Record<string, unknown>;
		try {
			body = await event.request.json();
		} catch {
			return json({ error: "Invalid JSON" }, { status: 400 });
		}

		const model = await updateProviderModelFromPayload(modelId, body);

		if (!model) {
			return json({ error: "Model not found" }, { status: 404 });
		}

		return json({ model });
	} catch (error) {
		if (isProviderModelValidationError(error)) {
			return json({ error: error.message }, { status: 400 });
		}
		console.error("[ADMIN] Failed to update provider model:", error);
		return json({ error: "Failed to update provider model" }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async (event) => {
	try {
		requireAdmin(event);
		const { modelId } = event.params;

		const deleted = await deleteProviderModel(modelId);

		if (!deleted) {
			return json({ error: "Model not found" }, { status: 404 });
		}

		return json({ success: true });
	} catch (error) {
		console.error("[ADMIN] Failed to delete provider model:", error);
		return json({ error: "Failed to delete provider model" }, { status: 500 });
	}
};
