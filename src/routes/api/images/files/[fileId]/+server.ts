import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import { buildContentDisposition } from "$lib/server/services/file-serving-response-policy";
import {
	getImageFile,
	type ImageFile,
	imageFileDownloadName,
	readImageDisplayBytes,
	readImageFileBytes,
} from "$lib/server/services/images/files";
import { VideoMediaError } from "$lib/server/services/images/video/media";
import {
	getVideoFile,
	readVideoFileBytes,
	readVideoGifBytes,
	type VideoFile,
	videoFileDownloadName,
	videoGifDownloadName,
} from "$lib/server/services/images/video-files";
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

type ByteRange = { start: number; end: number };

/**
 * One `Range` header as a byte range of the clip, `"unsatisfiable"` when its
 * first byte is at or past the end (RFC 9110 14.1.1), or `null` when the header
 * is not one this route honours: malformed, several ranges, an empty specifier,
 * or an end before its start. An unhonoured header is ignored and the whole
 * representation is served, as the RFC allows — only a well-formed range gets
 * a partial answer.
 */
function parseByteRange(
	header: string,
	size: number,
): ByteRange | "unsatisfiable" | null {
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match) return null;
	const [, first, last] = match;
	if (first === "" && last === "") return null;
	if (first === "") {
		// A suffix range: the last `last` bytes, `-0` asks for nothing.
		const suffix = Number(last);
		if (!Number.isSafeInteger(suffix) || suffix <= 0) return "unsatisfiable";
		return { start: Math.max(0, size - suffix), end: size - 1 };
	}
	const start = Number(first);
	const end = last === "" ? size - 1 : Number(last);
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
	// A first byte at or past the end is unsatisfiable whatever the last one
	// says; only then is "end before start" just a malformed spec to ignore.
	if (start >= size) return "unsatisfiable";
	if (end < start) return null;
	return { start, end: Math.min(end, size - 1) };
}

/**
 * A clip's GIF download (`?download=1&format=gif`): made once beside the clip
 * on the first request and served from the cache after that. A GIF is small
 * and whole, so it ignores `Range`. A conversion that fails answers an error —
 * never the mp4 under another name, and never a stored half-file.
 */
async function serveGif(
	event: Parameters<RequestHandler>[0],
	file: ImageFile,
	video: VideoFile,
): Promise<Response> {
	// The GIF is immutable for its file id, so the id and the format make a
	// validator that never lies.
	const etag = `"${video.id}:gif"`;
	const cacheControl = "private, max-age=3600";
	if (matchesIfNoneMatch(event.request.headers.get("if-none-match"), etag)) {
		return new Response(null, {
			status: 304,
			headers: {
				ETag: etag,
				"Cache-Control": cacheControl,
				"Content-Type": "image/gif",
				"X-Content-Type-Options": "nosniff",
			},
		});
	}

	let bytes: Uint8Array;
	try {
		bytes = await readVideoGifBytes(video);
	} catch (error) {
		// A box without ffmpeg answers the take's own media-unavailable
		// meaning; a clip ffmpeg cannot decode is its failed conversion.
		const unavailable =
			error instanceof VideoMediaError && error.code === "unavailable";
		return json(
			{ error: unavailable ? "video_media_unavailable" : "video_media_failed" },
			{ status: unavailable ? 503 : 500 },
		);
	}
	return new Response(bytes.slice(), {
		status: 200,
		headers: {
			"Content-Type": "image/gif",
			"Content-Length": String(bytes.byteLength),
			"Cache-Control": cacheControl,
			"X-Content-Type-Options": "nosniff",
			"Content-Disposition": buildContentDisposition(
				"attachment",
				await videoGifDownloadName(file),
			),
			ETag: etag,
		},
	});
}

/**
 * A stored clip's GET: the mp4 with `Range` (Safari will not play without it),
 * `?variant=poster`/`?variant=thumb` as WebP, `?download=1` the whole original,
 * and `?download=1&format=gif` the GIF made beside it. The caller has already
 * read the row through `getImageFile`, so the ownership scope and the 404 are
 * the picture path's own.
 */
async function serveVideo(
	event: Parameters<RequestHandler>[0],
	file: ImageFile,
	video: VideoFile,
): Promise<Response> {
	const variant = event.url.searchParams.get("variant");
	const format = event.url.searchParams.get("format");
	// A download is always the original clip, whatever variant the caller named.
	const download = event.url.searchParams.get("download") === "1";
	// A GIF is asked for by name, and only as a download: the player asks for
	// the clip itself, with ranges. A row without a length is not a clip (it is
	// a picture), and is never turned into a GIF.
	if (download && format === "gif") {
		if (video.durationMs === null) {
			return json({ error: "Not found" }, { status: 404 });
		}
		return serveGif(event, file, video);
	}
	const representation = download
		? "download"
		: variant === "poster"
			? "poster"
			: variant === "thumb"
				? "thumb"
				: "video";
	// Every representation of a clip is immutable for its file id, so a strong
	// tag from the id and the representation is a validator that never lies.
	const etag = `"${video.id}:${representation}"`;

	let bytes: Uint8Array;
	try {
		bytes = await readVideoFileBytes(
			video,
			representation === "poster"
				? "poster"
				: representation === "thumb"
					? "thumb"
					: "video",
		);
	} catch {
		return json({ error: "Not found" }, { status: 404 });
	}
	const isPictureVariant =
		representation === "poster" || representation === "thumb";
	const contentType = isPictureVariant ? "image/webp" : "video/mp4";
	const cacheControl = "private, max-age=3600";
	const headers: Record<string, string> = {
		"Content-Type": contentType,
		"Cache-Control": cacheControl,
		"X-Content-Type-Options": "nosniff",
		ETag: etag,
	};
	// Only the player's own representation honours a range; a download is the
	// whole original, whatever header it arrives with.
	if (representation === "video") headers["Accept-Ranges"] = "bytes";
	if (download) {
		headers["Content-Disposition"] = buildContentDisposition(
			"attachment",
			await videoFileDownloadName(file),
		);
	}

	if (matchesIfNoneMatch(event.request.headers.get("if-none-match"), etag)) {
		return new Response(null, {
			status: 304,
			headers: {
				ETag: etag,
				"Cache-Control": cacheControl,
				"Content-Type": contentType,
				"X-Content-Type-Options": headers["X-Content-Type-Options"],
			},
		});
	}

	// A download is the whole file; a range is a player's request for the clip.
	if (!download) {
		const header = event.request.headers.get("range");
		if (header) {
			const range = parseByteRange(header, bytes.byteLength);
			if (range === "unsatisfiable") {
				return new Response(null, {
					status: 416,
					headers: {
						"Content-Range": `bytes */${bytes.byteLength}`,
						"Accept-Ranges": "bytes",
						"Content-Length": "0",
						"Cache-Control": cacheControl,
						"X-Content-Type-Options": headers["X-Content-Type-Options"],
						ETag: etag,
					},
				});
			}
			if (range) {
				const body = bytes.slice(range.start, range.end + 1);
				return new Response(body, {
					status: 206,
					headers: {
						...headers,
						"Content-Length": String(body.byteLength),
						"Content-Range": `bytes ${range.start}-${range.end}/${bytes.byteLength}`,
					},
				});
			}
		}
	}

	headers["Content-Length"] = String(bytes.byteLength);
	return new Response(bytes.slice(), { status: 200, headers });
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

	// A clip is a row of the same table: the picture read above owns the scope,
	// and the row's own path says which of the two it is.
	const video = await getVideoFile(file);
	if (video) return serveVideo(event, file, video);

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
