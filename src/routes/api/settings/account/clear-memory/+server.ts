import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { clearMemoryAndKnowledge } from "$lib/server/services/privacy-controls";
import type { RequestHandler } from "./$types";

function parsePasswordBody(body: unknown): string | null {
	if (!body || typeof body !== "object") return null;
	const password = (body as { password?: unknown }).password;
	return typeof password === "string" ? password : null;
}

async function readJsonBody(
	event: Parameters<RequestHandler>[0],
): Promise<unknown | Response> {
	try {
		return await event.request.json();
	} catch {
		return json({ error: "Invalid JSON" }, { status: 400 });
	}
}

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const userId = event.locals.user?.id;

	const body = await readJsonBody(event);
	if (body instanceof Response) {
		return body;
	}

	const password = parsePasswordBody(body);
	if (!password) {
		return json({ error: "password is required" }, { status: 400 });
	}

	try {
		const result = await clearMemoryAndKnowledge(userId, password);

		if (result.status === "not_found") {
			return json({ error: "User not found" }, { status: 404 });
		}

		if (result.status === "incorrect_password") {
			return json({ error: "Incorrect password" }, { status: 401 });
		}

		return json({
			success: true,
			deletedArtifactIds: result.deletedArtifactIds,
		});
	} catch (error) {
		console.error("[CLEAR_MEMORY] Failed to clear memory and knowledge:", error);
		return json(
			{ error: "Failed to clear memory and knowledge" },
			{ status: 500 },
		);
	}
};
