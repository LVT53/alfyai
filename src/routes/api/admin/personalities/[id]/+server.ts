import { json } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/auth/hooks";
import {
	deletePersonalityProfile,
	updatePersonalityProfile,
} from "$lib/server/services/personality-profiles";
import type { RequestHandler } from "./$types";

export const PUT: RequestHandler = async (event) => {
	requireAdmin(event);
	const { id } = event.params;

	let body: { name?: unknown; description?: unknown; promptText?: unknown };
	try {
		body = await event.request.json();
	} catch {
		return json({ error: "Invalid JSON" }, { status: 400 });
	}

	const updates: { name?: string; description?: string; promptText?: string } =
		{};
	if (typeof body.name === "string" && body.name.trim())
		updates.name = body.name.trim();
	if (typeof body.description === "string")
		updates.description = body.description.trim();
	if (typeof body.promptText === "string") updates.promptText = body.promptText;

	if (Object.keys(updates).length === 0) {
		return json({ error: "No fields to update" }, { status: 400 });
	}

	try {
		const profile = await updatePersonalityProfile(id, updates);
		if (!profile) return json({ error: "Profile not found" }, { status: 404 });
		return json({ profile });
	} catch (error: unknown) {
		if (error instanceof Error && error.message.includes("UNIQUE constraint")) {
			return json(
				{ error: "A profile with that name already exists." },
				{ status: 409 },
			);
		}
		throw error;
	}
};

export const DELETE: RequestHandler = async (event) => {
	requireAdmin(event);
	const { id } = event.params;

	try {
		const deleted = await deletePersonalityProfile(id);
		if (!deleted)
			return json(
				{ error: "Cannot delete built-in profile or profile not found." },
				{ status: 400 },
			);
		return json({ success: true });
	} catch (error) {
		console.error("[ADMIN_PERSONALITIES_DELETE] Failed:", error);
		return json({ error: "Failed to delete profile." }, { status: 500 });
	}
};
