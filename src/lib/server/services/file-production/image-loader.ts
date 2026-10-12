import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { artifacts } from "$lib/server/db/schema";
import {
	assessOutboundUrl,
	createOutboundFetch,
	type OutboundFailureCode,
	type OutboundFetch,
	OutboundFetchError,
} from "$lib/server/outbound";
import {
	type ChatFile,
	getChatFileByConversationOwner,
	readChatFileContentByConversationOwner,
} from "$lib/server/services/chat-files";
import { getFileProductionLimits } from "./limits";
import type { GeneratedDocumentImageSource } from "./source-schema";

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
/** A picture that takes longer than this is not worth holding a report render for. */
const IMAGE_FETCH_TIMEOUT_MS = 15_000;

export interface LoadedGeneratedDocumentImage {
	bytes: Buffer;
	mimeType: "image/png" | "image/jpeg" | "image/webp";
	sourceDescription: string;
}

export type GeneratedDocumentImageLoadResult =
	| { ok: true; image: LoadedGeneratedDocumentImage }
	| { ok: false; code: "image_limit_exceeded"; message: string };

export interface LoadGeneratedDocumentImageOptions {
	maxImageBytes?: number;
	/**
	 * A test's fetch. The default is the outbound one (public addresses only);
	 * never pass `globalThis.fetch` outside a test.
	 */
	fetchImpl?: OutboundFetch;
	resolveArtifact?: (
		artifactId: string,
	) => Promise<{ bytes: Buffer; mimeType: string | null } | null>;
	resolveGeneratedFile?: (
		fileId: string,
	) => Promise<{ bytes: Buffer; mimeType: string | null } | null>;
}

function failure(message: string): GeneratedDocumentImageLoadResult {
	return { ok: false, code: "image_limit_exceeded", message };
}

function normalizeMimeType(
	value: string | null | undefined,
): LoadedGeneratedDocumentImage["mimeType"] | null {
	const mimeType = value?.split(";")[0]?.trim().toLowerCase() ?? "";
	return IMAGE_MIME_TYPES.has(mimeType)
		? (mimeType as LoadedGeneratedDocumentImage["mimeType"])
		: null;
}

function detectImageMimeType(
	bytes: Buffer,
): LoadedGeneratedDocumentImage["mimeType"] | null {
	if (
		bytes
			.subarray(0, 8)
			.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
	) {
		return "image/png";
	}
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return "image/jpeg";
	}
	if (
		bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
		bytes.subarray(8, 12).toString("ascii") === "WEBP"
	) {
		return "image/webp";
	}
	return null;
}

function decodeDataImage(
	source: Extract<GeneratedDocumentImageSource, { kind: "data" }>,
): Buffer | null {
	const dataUriMatch = source.data.match(/^data:([^;,]+);base64,(.+)$/i);
	const encoded = dataUriMatch ? dataUriMatch[2] : source.data;
	try {
		return Buffer.from(encoded, "base64");
	} catch {
		return null;
	}
}

/**
 * The up-front half of the SSRF guard: an https URL with no credentials whose
 * host is not an address that is not public and not a name that can only be
 * somebody's private network. It runs on every hop, before anything is sent,
 * and the fetch itself judges the address a name resolves to when it connects
 * (`$lib/server/outbound`), so a name that points inside is refused there.
 */
function validateHttpsUrl(url: string): URL | null {
	const verdict = assessOutboundUrl(url);
	return verdict.ok ? verdict.url : null;
}

/** What a failed fetch is reported as: no host, no address, no cause text. */
function failureMessageFor(code: OutboundFailureCode): string {
	switch (code) {
		case "too_large":
			return "Image bytes exceed the configured limit.";
		case "timeout":
			return "Image request timed out.";
		case "bad_url":
		case "blocked_scheme":
		case "blocked_host":
		case "blocked_address":
			return "Image URL is not an allowed HTTPS URL.";
		default:
			return "Image request failed.";
	}
}

function validateLoadedImage(
	bytes: Buffer,
	declaredMimeType: string | null | undefined,
	sourceDescription: string,
	maxImageBytes: number,
): GeneratedDocumentImageLoadResult {
	if (bytes.length === 0 || bytes.length > maxImageBytes) {
		return failure("Image bytes exceed the configured limit.");
	}
	const mimeType =
		normalizeMimeType(declaredMimeType) ?? detectImageMimeType(bytes);
	if (!mimeType || detectImageMimeType(bytes) !== mimeType) {
		return failure("Image bytes are not a supported image type.");
	}
	return {
		ok: true,
		image: {
			bytes,
			mimeType,
			sourceDescription,
		},
	};
}

async function fetchHttpsImage(
	source: Extract<GeneratedDocumentImageSource, { kind: "https" }>,
	options: LoadGeneratedDocumentImageOptions,
	maxImageBytes: number,
): Promise<GeneratedDocumentImageLoadResult> {
	// The default fetch connects to public addresses only, with a byte cap and a
	// timeout of its own; a `fetchImpl` is a test's.
	const fetchImpl =
		options.fetchImpl ??
		createOutboundFetch(
			{},
			{ maxBytes: maxImageBytes, timeoutMs: IMAGE_FETCH_TIMEOUT_MS },
		);
	let currentUrl = validateHttpsUrl(source.url);
	if (!currentUrl) return failure("Image URL is not an allowed HTTPS URL.");

	for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
		let response: Response;
		try {
			response = await fetchImpl(currentUrl, { redirect: "manual" });
		} catch (error) {
			// A refused or unreachable picture is a placeholder in the report (or
			// a failed block when it is critical), never a failed render.
			return failure(
				error instanceof OutboundFetchError
					? failureMessageFor(error.code)
					: "Image request failed.",
			);
		}
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location) return failure("Image redirect is missing a target.");
			// Every hop is judged like the first request.
			try {
				currentUrl = validateHttpsUrl(new URL(location, currentUrl).toString());
			} catch {
				currentUrl = null;
			}
			if (!currentUrl) return failure("Image redirect target is not allowed.");
			continue;
		}
		if (!response.ok) return failure("Image request failed.");
		const contentType = response.headers.get("content-type");
		const contentLength = Number.parseInt(
			response.headers.get("content-length") ?? "",
			10,
		);
		if (Number.isFinite(contentLength) && contentLength > maxImageBytes) {
			return failure("Image bytes exceed the configured limit.");
		}
		const bytes = Buffer.from(await response.arrayBuffer());
		return validateLoadedImage(
			bytes,
			contentType,
			currentUrl.toString(),
			maxImageBytes,
		);
	}

	return failure("Image redirected too many times.");
}

export async function loadGeneratedDocumentImage(
	source: GeneratedDocumentImageSource,
	options: LoadGeneratedDocumentImageOptions = {},
): Promise<GeneratedDocumentImageLoadResult> {
	const maxImageBytes =
		options.maxImageBytes ?? getFileProductionLimits().maxImageBytes;

	if (source.kind === "data") {
		const bytes = decodeDataImage(source);
		if (!bytes) return failure("Image data could not be decoded.");
		return validateLoadedImage(
			bytes,
			source.mimeType,
			"data image",
			maxImageBytes,
		);
	}

	if (source.kind === "https") {
		return fetchHttpsImage(source, options, maxImageBytes);
	}

	if (source.kind === "artifact") {
		const resolved = await options.resolveArtifact?.(source.artifactId);
		if (!resolved) return failure("Image artifact could not be resolved.");
		return validateLoadedImage(
			resolved.bytes,
			resolved.mimeType,
			"artifact image",
			maxImageBytes,
		);
	}

	const resolved = await options.resolveGeneratedFile?.(source.fileId);
	if (!resolved) return failure("Generated image file could not be resolved.");
	return validateLoadedImage(
		resolved.bytes,
		resolved.mimeType,
		"generated file image",
		maxImageBytes,
	);
}

export function createDefaultGeneratedDocumentImageLoader(params: {
	userId: string;
	conversationId: string;
	fetchImpl?: OutboundFetch;
}) {
	return async (
		source: GeneratedDocumentImageSource,
	): Promise<GeneratedDocumentImageLoadResult> => {
		return loadGeneratedDocumentImage(source, {
			fetchImpl: params.fetchImpl,
			resolveGeneratedFile: async (fileId) => {
				const file: ChatFile | null = await getChatFileByConversationOwner(
					fileId,
					params.userId,
				);
				if (!file) return null;
				const bytes = await readChatFileContentByConversationOwner(
					fileId,
					params.userId,
				);
				return bytes ? { bytes, mimeType: file.mimeType } : null;
			},
			resolveArtifact: async (artifactId) => {
				const [artifact] = await db
					.select({
						mimeType: artifacts.mimeType,
						storagePath: artifacts.storagePath,
					})
					.from(artifacts)
					.where(
						and(
							eq(artifacts.id, artifactId),
							eq(artifacts.userId, params.userId),
						),
					)
					.limit(1);
				if (!artifact?.storagePath) return null;
				const bytes = await readFile(join(process.cwd(), artifact.storagePath));
				return { bytes, mimeType: artifact.mimeType };
			},
		});
	};
}
