import { json } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/auth/hooks";
import {
	createPersonalityProfile,
	listPersonalityProfiles,
	seedPersonalityProfiles,
} from "$lib/server/services/personality-profiles";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAdmin(event);
	try {
		await seedPersonalityProfiles();
		const profiles = await listPersonalityProfiles();
		return json({ profiles });
	} catch (error) {
		console.error("[ADMIN_PERSONALITIES] Failed to list:", error);
		return json(
			{ error: "Failed to load personality profiles." },
			{ status: 500 },
		);
	}
};

export const POST: RequestHandler = async (event) => {
	requireAdmin(event);
	let body: { name?: unknown; description?: unknown; promptText?: unknown };
	try {
		body = await event.request.json();
	} catch {
		return json({ error: "Invalid JSON" }, { status: 400 });
	}

	if (typeof body.name !== "string" || !body.name.trim()) {
		return json({ error: "Name is required" }, { status: 400 });
	}
	if (typeof body.promptText !== "string") {
		return json({ error: "Prompt text is required" }, { status: 400 });
	}

	try {
		const profile = await createPersonalityProfile({
			name: body.name.trim(),
			description:
				typeof body.description === "string" ? body.description.trim() : "",
			promptText: body.promptText,
		});
		return json({ profile }, { status: 201 });
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
