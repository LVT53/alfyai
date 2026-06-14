import { json } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/auth/hooks";
import {
	createProviderModelFromPayload,
	listProviderModels,
} from "$lib/server/services/provider-models";
import type { RequestHandler } from "./$types";

function isProviderModelValidationError(error: unknown): error is Error {
	return (
		error instanceof Error && error.name === "ProviderModelValidationError"
	);
}

export const GET: RequestHandler = async (event) => {
	try {
		requireAdmin(event);
		const { id } = event.params;
		const models = await listProviderModels(id);
		return json({ models });
	} catch (error) {
		console.error("[ADMIN] Failed to list provider models:", error);
		return json({ error: "Failed to list provider models" }, { status: 500 });
	}
};

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

		const model = await createProviderModelFromPayload(id, body);

		return json({ model }, { status: 201 });
	} catch (error) {
		if (isProviderModelValidationError(error)) {
			return json({ error: error.message }, { status: 400 });
		}
		if (error instanceof Error && error.message.includes("does not exist")) {
			return json({ error: error.message }, { status: 404 });
		}
		console.error("[ADMIN] Failed to create provider model:", error);
		return json({ error: "Failed to create provider model" }, { status: 500 });
	}
};
