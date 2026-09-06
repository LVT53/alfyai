import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	addMemoryProfileItemProvenance,
	createMemoryProfileItem,
	mergeMemoryProfileItemMetadata,
} from "$lib/server/services/memory-profile/projection-store";
import type { RequestHandler } from "./$types";

// Composer `/remember <text>` writes here. Server-owned, capped, and routed
// through the existing memory profile item store (createMemoryProfileItem)
// rather than a new table — the item is marked `origin: "user_authored"` so
// the memory judge/consolidation passes never touch or retire it (mirrors
// the manual-edit path in knowledge-memory-actions.ts).
const MAX_NOTE_LENGTH = 2000;

function parseNoteText(body: unknown): string | null {
	if (!body || typeof body !== "object") return null;
	const text = (body as { text?: unknown }).text;
	if (typeof text !== "string") return null;
	const trimmed = text.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	const body = await event.request.json().catch(() => null);
	const text = parseNoteText(body);
	if (!text) {
		return json({ error: "text is required" }, { status: 400 });
	}
	if (text.length > MAX_NOTE_LENGTH) {
		return json(
			{ error: `text must be ${MAX_NOTE_LENGTH} characters or fewer` },
			{ status: 400 },
		);
	}

	try {
		const item = await createMemoryProfileItem({
			userId: user.id,
			category: "about_you",
			scope: { type: "global" },
			statement: text,
			status: "active",
		});
		await mergeMemoryProfileItemMetadata({
			userId: user.id,
			itemId: item.id,
			patch: { origin: "user_authored" },
		});
		await addMemoryProfileItemProvenance({
			userId: user.id,
			itemId: item.id,
			sourceType: "composer_command",
			label: "/remember command",
		});
		return json({ id: item.id, statement: text });
	} catch (error) {
		console.error("[MEMORY_NOTES] Failed to save memory note:", error);
		return json({ error: "Failed to save memory note" }, { status: 500 });
	}
};
