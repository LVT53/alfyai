import { json } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/auth/hooks";
import { refreshConfig } from "$lib/server/config-store";
import {
	deleteProvider,
	type UpdateProviderInput,
	updateProvider,
} from "$lib/server/services/providers";
import type { RequestHandler } from "./$types";

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

function buildProviderUpdateInput(body: Record<string, unknown>): {
	input: UpdateProviderInput;
	error?: string;
} {
	const input: UpdateProviderInput = {};

	if (body.displayName !== undefined) {
		if (typeof body.displayName !== "string") {
			return { input: {}, error: "displayName must be a string" };
		}
		input.displayName = body.displayName.trim();
	}

	if (body.baseUrl !== undefined) {
		if (typeof body.baseUrl !== "string") {
			return { input: {}, error: "baseUrl must be a string" };
		}
		input.baseUrl = body.baseUrl.trim();
	}

	if (body.apiKey !== undefined) {
		if (typeof body.apiKey !== "string") {
			return { input: {}, error: "apiKey must be a string" };
		}
		input.apiKey = body.apiKey;
	}

	if (body.iconAssetId !== undefined) {
		input.iconAssetId =
			typeof body.iconAssetId === "string" && body.iconAssetId.trim()
				? body.iconAssetId.trim()
				: null;
	}

	if (body.rateLimitFallbackEnabled !== undefined) {
		if (typeof body.rateLimitFallbackEnabled !== "boolean") {
			return {
				input: {},
				error: "rateLimitFallbackEnabled must be a boolean",
			};
		}
		input.rateLimitFallbackEnabled = body.rateLimitFallbackEnabled;
	}

	if (body.rateLimitFallbackBaseUrl !== undefined) {
		input.rateLimitFallbackBaseUrl =
			typeof body.rateLimitFallbackBaseUrl === "string"
				? body.rateLimitFallbackBaseUrl.trim()
				: null;
	}

	if (body.rateLimitFallbackApiKey !== undefined) {
		input.rateLimitFallbackApiKey =
			typeof body.rateLimitFallbackApiKey === "string"
				? body.rateLimitFallbackApiKey
				: null;
	}

	if (body.rateLimitFallbackModelName !== undefined) {
		input.rateLimitFallbackModelName =
			typeof body.rateLimitFallbackModelName === "string"
				? body.rateLimitFallbackModelName.trim()
				: null;
	}

	if (body.rateLimitFallbackTimeoutMs !== undefined) {
		if (
			typeof body.rateLimitFallbackTimeoutMs !== "number" ||
			body.rateLimitFallbackTimeoutMs < 0
		) {
			return {
				input: {},
				error: "rateLimitFallbackTimeoutMs must be a non-negative number",
			};
		}
		input.rateLimitFallbackTimeoutMs = body.rateLimitFallbackTimeoutMs;
	}

	if (body.sortOrder !== undefined) {
		if (typeof body.sortOrder !== "number") {
			return { input: {}, error: "sortOrder must be a number" };
		}
		input.sortOrder = body.sortOrder;
	}

	if (body.enabled !== undefined) {
		if (typeof body.enabled !== "boolean") {
			return { input: {}, error: "enabled must be a boolean" };
		}
		input.enabled = body.enabled;
	}

	return { input };
}
