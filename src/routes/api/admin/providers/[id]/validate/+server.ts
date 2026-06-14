import { json } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/auth/hooks";
import {
	decryptApiKey,
	getProviderWithSecrets,
	validateProviderConnection,
} from "$lib/server/services/providers";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
	try {
		requireAdmin(event);
		const { id } = event.params;

		const provider = await getProviderWithSecrets(id);

		if (!provider) {
			return json({ error: "Provider not found" }, { status: 404 });
		}

		let apiKey: string;
		try {
			apiKey = decryptApiKey(provider.apiKeyEncrypted, provider.apiKeyIv);
		} catch {
			return json({ valid: false, error: "Failed to decrypt API key" });
		}

		const result = await validateProviderConnection(provider.baseUrl, apiKey);
		return json(result);
	} catch (error) {
		console.error("[ADMIN] Failed to validate provider:", error);
		return json({ error: "Failed to validate provider" }, { status: 500 });
	}
};
