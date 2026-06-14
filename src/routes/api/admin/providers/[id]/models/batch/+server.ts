import { json } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/auth/hooks";
import { batchCreateProviderModelsFromPayload } from "$lib/server/services/provider-models";
import { isProviderModelValidationError } from "../provider-model-route-errors";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
	try {
		requireAdmin(event);
		const { id } = event.params;

		let body: Record<string, unknown>;
		try {
			body = await event.request.json();
		} catch {
			return json({ error: "Invalid JSON" }, { status: 400 });
		}

		const models = await batchCreateProviderModelsFromPayload(id, body);

		return json({ models }, { status: 201 });
	} catch (error) {
		if (isProviderModelValidationError(error)) {
			return json({ error: error.message }, { status: 400 });
		}
		if (error instanceof Error && error.message.includes("does not exist")) {
			return json({ error: error.message }, { status: 404 });
		}
		console.error("[ADMIN] Failed to batch create provider models:", error);
		return json(
			{ error: "Failed to batch create provider models" },
			{ status: 500 },
		);
	}
};
