import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import { buildContentDisposition } from "$lib/server/services/file-serving-response-policy";
import {
	getImageFile,
	imageFileDownloadName,
	readImageFileBytes,
} from "$lib/server/services/images/files";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const conversationId = event.url.searchParams.get("conversationId");
	const file = await getImageFile({
		userId: user.id,
		fileId: event.params.fileId,
		conversationId,
	});
	if (!file) return json({ error: "Not found" }, { status: 404 });

	let bytes: Uint8Array;
	try {
		bytes = await readImageFileBytes(
			file,
			event.url.searchParams.get("variant") === "thumb" ? "thumb" : "full",
		);
	} catch {
		return json({ error: "Not found" }, { status: 404 });
	}

	const headers: Record<string, string> = {
		"Content-Type": "image/png",
		"Content-Length": String(bytes.byteLength),
		"Cache-Control": "private, max-age=3600",
		"X-Content-Type-Options": "nosniff",
	};
	if (event.url.searchParams.get("download") === "1") {
		const name = await imageFileDownloadName(file);
		headers["Content-Disposition"] = buildContentDisposition(
			"attachment",
			name,
		);
	}
	return new Response(bytes.slice(), { status: 200, headers });
};
