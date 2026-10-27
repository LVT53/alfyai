import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
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
		"Cache-Control": "private, max-age=31536000, immutable",
		"X-Content-Type-Options": "nosniff",
	};
	if (event.url.searchParams.get("download") === "1") {
		const name = await imageFileDownloadName(file);
		const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
		headers["Content-Disposition"] =
			`attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
	}
	return new Response(bytes.slice(), { status: 200, headers });
};
