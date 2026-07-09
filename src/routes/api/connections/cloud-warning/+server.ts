import { json } from "@sveltejs/kit";
import { createJsonErrorResponse } from "$lib/server/api/responses";
import { requireAuth } from "$lib/server/auth/hooks";
import { shouldWarnCloudConnector } from "$lib/server/services/connections/locality";
import {
	CAPABILITIES,
	type Capability,
} from "$lib/server/services/connections/registry";
import { getEnabledConnectionCapabilities } from "$lib/server/services/connections/resolve";
import type { RequestHandler } from "./$types";

const MAX_MODEL_ID_LENGTH = 200;

function isCapability(value: unknown): value is Capability {
	return (
		typeof value === "string" &&
		(CAPABILITIES as readonly string[]).includes(value)
	);
}

interface CloudWarningBody {
	modelId?: unknown;
	capabilities?: unknown;
}

// POST /api/connections/cloud-warning — Option C (Issue 7.4). The composer
// calls this right before sending to a cloud model while the user has
// active connector capabilities, to decide whether to show the one-time
// "connector data may reach a cloud model" warning.
//
// The client-supplied `capabilities` are never trusted at face value: only
// their intersection with the caller's actually-SERVED capabilities
// (getEnabledConnectionCapabilities) is passed to shouldWarnCloudConnector,
// so a client can't force (or spoof) a warn state by claiming capabilities
// it doesn't actually have connected. This is a boolean gate for a modal —
// it never exposes any connector data — but the intersection keeps the
// signal honest regardless.
export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const userId = event.locals.user.id;

	let body: CloudWarningBody;
	try {
		body = await event.request.json();
	} catch {
		return createJsonErrorResponse("Invalid JSON", 400);
	}

	if (
		typeof body.modelId !== "string" ||
		body.modelId.trim() === "" ||
		body.modelId.length > MAX_MODEL_ID_LENGTH
	) {
		return createJsonErrorResponse("modelId must be a non-empty string", 400);
	}
	if (!Array.isArray(body.capabilities)) {
		return createJsonErrorResponse(
			"capabilities must be an array of strings",
			400,
		);
	}

	const claimedCapabilities = body.capabilities
		.filter(isCapability)
		.slice(0, CAPABILITIES.length);
	const served = await getEnabledConnectionCapabilities(userId);
	const activeCapabilities = claimedCapabilities.filter((capability) =>
		served.has(capability),
	);

	const shouldWarn = await shouldWarnCloudConnector({
		userId,
		modelId: body.modelId,
		activeCapabilities,
	});

	return json({ shouldWarn });
};
