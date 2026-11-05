import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	ChatGptImportAlreadyRunningError,
	ChatGptImportNoSelectionError,
	ChatGptImportProjectAccessError,
	importConversations,
} from "$lib/server/services/chatgpt-import";
import type { RequestHandler } from "./$types";

// The conversations the person ticked, as the browser posts them: a JSON list of
// the ids the export gives its conversations, each once, in the order named. A
// missing field is an empty list; anything else that is not a list of ids is
// null.
function readConversationIds(
	field: FormDataEntryValue | null,
): string[] | null {
	if (field === null) return [];
	if (typeof field !== "string") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(field);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed)) return null;
	const ids = new Set<string>();
	for (const item of parsed) {
		if (typeof item !== "string" || item.trim().length === 0) return null;
		ids.add(item);
	}
	return [...ids];
}

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;

	let formData: FormData;
	try {
		formData = await event.request.formData();
	} catch {
		return json({ error: "Invalid form data" }, { status: 400 });
	}

	const file = formData.get("file");
	if (!(file instanceof File)) {
		return json({ error: "No file provided" }, { status: 400 });
	}

	if (file.size === 0) {
		return json({ error: "Empty file" }, { status: 400 });
	}

	if (!file.name.toLowerCase().endsWith(".zip")) {
		return json({ error: "File must be a .zip file" }, { status: 400 });
	}

	const conversationIds = readConversationIds(formData.get("conversationIds"));
	if (conversationIds === null) {
		return json({ error: "Invalid conversation selection" }, { status: 400 });
	}
	if (conversationIds.length === 0) {
		return json(
			{ error: "Select at least one conversation to import" },
			{ status: 400 },
		);
	}

	const projectIdField = formData.get("projectId");
	const projectId =
		typeof projectIdField === "string" && projectIdField.trim()
			? projectIdField.trim()
			: null;

	let zipBuffer: Buffer;
	try {
		const arrayBuffer = await file.arrayBuffer();
		zipBuffer = Buffer.from(arrayBuffer);
	} catch {
		return json({ error: "Failed to read uploaded file" }, { status: 400 });
	}

	try {
		const result = await importConversations(user.id, zipBuffer, {
			projectId,
			conversationIds,
		});
		return json(result);
	} catch (err) {
		if (err instanceof ChatGptImportNoSelectionError) {
			return json({ error: err.message }, { status: 400 });
		}
		if (err instanceof ChatGptImportAlreadyRunningError) {
			return json(
				{ error: err.message, errorKey: err.errorKey },
				{ status: 409 },
			);
		}
		if (err instanceof ChatGptImportProjectAccessError) {
			return json({ error: err.message }, { status: 400 });
		}
		console.error("[CHATGPT_IMPORT] Import failed:", err);
		return json(
			{
				error: "Import failed",
				details: err instanceof Error ? err.message : "Unknown error",
			},
			{ status: 500 },
		);
	}
};
