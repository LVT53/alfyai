import { json } from "@sveltejs/kit";
import { openChannelFiles } from "$lib/server/services/connections/providers/teams-channel-files";
import { getConnection } from "$lib/server/services/connections/store";
import { buildFileServingResponseHeaders } from "$lib/server/services/file-serving-response-policy";
import { getContentTypeForFile } from "$lib/shared/file-types";
import type { RequestHandler } from "./$types";
export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) return json({ error: "Unauthorized" }, { status: 401 });
	const q = url.searchParams;
	const connectionId = q.get("connectionId"),
		teamId = q.get("teamId"),
		channelId = q.get("channelId"),
		id = q.get("itemId"),
		revision = q.get("revision"),
		path = q.get("path");
	if (!connectionId || !teamId || !channelId || !id || !revision || !path)
		return json({ error: "Missing file reference" }, { status: 400 });
	const conn = await getConnection(locals.user.id, connectionId);
	if (
		conn?.provider !== "onedrive" ||
		conn.status !== "connected" ||
		!conn.capabilities.includes("teams_files")
	)
		return json({ error: "File unavailable" }, { status: 404 });
	try {
		const channel = await openChannelFiles(conn, { teamId, channelId });
		const file = await channel.read(path, { id, revision });
		const headers = buildFileServingResponseHeaders({
			mode: "download",
			filename: file.name,
			contentType: getContentTypeForFile(file.name, file.contentType),
			contentLength: file.bytes.byteLength,
		});
		delete headers["Accept-Ranges"];
		return new Response(Uint8Array.from(file.bytes).buffer, {
			headers: {
				...headers,
				"X-Content-Type-Options": "nosniff",
				"Content-Security-Policy": "sandbox",
				"Referrer-Policy": "no-referrer",
			},
		});
	} catch {
		return json({ error: "File unavailable or changed" }, { status: 404 });
	}
};
