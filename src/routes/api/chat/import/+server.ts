import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { importConversations } from "$lib/server/services/chatgpt-import";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user!;

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
		});
		return json(result);
	} catch (err) {
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
