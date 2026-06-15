import { json } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/auth/hooks";
import { refreshConfig } from "$lib/server/config-store";
import { deleteProvider, updateProvider } from "$lib/server/services/providers";
import type { RequestHandler } from "./$types";
import { buildProviderUpdateInput } from "./provider-update-input";

export const PUT: RequestHandler = async (event) => {
	try {
		requireAdmin(event);
		const { id } = event.params;

		let body: Record<string, unknown>;
		try {
			body = await event.request.json();
		} catch {
			return json({ error: "Invalid JSON" }, { status: 400 });
		}

		const parsedInput = buildProviderUpdateInput(body);
		if (parsedInput.error) {
			return json({ error: parsedInput.error }, { status: 400 });
		}
		const input = parsedInput.input;

		const provider = await updateProvider(id, input);

		if (!provider) {
			return json({ error: "Provider not found" }, { status: 404 });
		}

		await refreshConfig();
		return json({ provider });
	} catch (error) {
		if (
			error instanceof Error &&
			(error.message.includes("Processing region") ||
				error.message.includes("Privacy policy URL"))
		) {
			return json({ error: error.message }, { status: 400 });
		}
		console.error("[ADMIN] Failed to update provider:", error);
		return json({ error: "Failed to update provider" }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async (event) => {
	try {
		requireAdmin(event);
		const { id } = event.params;

		const deleted = await deleteProvider(id);

		if (!deleted) {
			return json({ error: "Provider not found" }, { status: 404 });
		}

		await refreshConfig();
		return json({ success: true });
	} catch (error) {
		console.error("[ADMIN] Failed to delete provider:", error);
		return json({ error: "Failed to delete provider" }, { status: 500 });
	}
};
