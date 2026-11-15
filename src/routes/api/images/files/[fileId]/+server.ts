import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import { buildContentDisposition } from "$lib/server/services/file-serving-response-policy";
import {
	getImageFile,
	imageFileDownloadName,
	readImageDisplayBytes,
	readImageFileBytes,
} from "$lib/server/services/images/files";
import type { RequestHandler } from "./$types";

/**
 * `If-None-Match` is `*` or a comma list of entity-tags. A GET compares them
 * weakly (RFC 9110 13.1.2), so a `W/` prefix still matches our strong tag.
 */
function matchesIfNoneMatch(header: string | null, etag: string): boolean {
	if (!header) return false;
	for (const entry of header.split(",")) {
		const candidate = entry.trim();
		if (candidate === "*" || candidate.replace(/^W\//, "") === etag) {
			return true;
		}
	}
	return false;
}

export const GET: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const conversationId = event.url.searchParams.get("conversationId");
	const file = await getImageFile({
		userId: user.id,
		fileId: event.params.fileId,
		conversationId,
	});
	if (!file) return json({ error: "Not found" }, { status: 404 });

	const variant = event.url.searchParams.get("variant");
	// A download is always the original, whatever variant the caller named.
	const download = event.url.searchParams.get("download") === "1";
	// Every representation of a picture is immutable for its file id, so a
	// strong tag from the id and the representation is a validator that never
	// lies. The caching stays private and an hour long: file ids are not
	// content-addressed, and a deleted or incognito chat's pictures must not
	// outlive a logout.
	const representation = download
		? "download"
		: variant === "thumb"
			? "thumb"
			: variant === "display"
				? "display"
				: "full";
	const etag = `"${event.params.fileId}:${representation}"`;
	let bytes: Uint8Array;
	let contentType = "image/png";
	try {
		if (!download && variant === "display") {
			const display = await readImageDisplayBytes(file);
			if (display) {
				bytes = display;
				contentType = "image/webp";
			} else {
				// Small enough to be its own display copy: the original is served.
				bytes = await readImageFileBytes(file, "full");
			}
		} else if (!download && variant === "thumb") {
			bytes = await readImageFileBytes(file, "thumb");
		} else {
			bytes = await readImageFileBytes(file, "full");
		}
	} catch {
		// A display copy that cannot be made must not cost the picture: the
		// original is still a correct answer, only a larger one. Every other
		// variant is the answer or a 404, as before.
		if (download || variant !== "display") {
			return json({ error: "Not found" }, { status: 404 });
		}
		try {
			bytes = await readImageFileBytes(file, "full");
			contentType = "image/png";
		} catch {
			return json({ error: "Not found" }, { status: 404 });
		}
	}

	const headers: Record<string, string> = {
		"Content-Type": contentType,
		"Content-Length": String(bytes.byteLength),
		"Cache-Control": "private, max-age=3600",
		"X-Content-Type-Options": "nosniff",
	};
	if (download) {
		const name = await imageFileDownloadName(file);
		headers["Content-Disposition"] = buildContentDisposition(
			"attachment",
			name,
		);
	}
	headers.ETag = etag;
	if (matchesIfNoneMatch(event.request.headers.get("if-none-match"), etag)) {
		// Not modified: the same validators and caching as a 200, and no body.
		return new Response(null, {
			status: 304,
			headers: {
				ETag: etag,
				"Cache-Control": headers["Cache-Control"],
				"Content-Type": contentType,
				"X-Content-Type-Options": headers["X-Content-Type-Options"],
			},
		});
	}
	return new Response(bytes.slice(), { status: 200, headers });
};
