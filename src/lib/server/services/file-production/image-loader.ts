import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { artifacts } from "$lib/server/db/schema";
import {
	type ChatFile,
	getChatFileByConversationOwner,
	readChatFileContentByConversationOwner,
} from "$lib/server/services/chat-files";
import { getFileProductionLimits } from "./limits";
import type { GeneratedDocumentImageSource } from "./source-schema";

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const PRIVATE_HOSTNAMES = new Set([
	"localhost",
	"ip6-localhost",
	"ip6-loopback",
]);

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
	fetchImpl?: typeof fetch;
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

function isPrivateIpv4(hostname: string): boolean {
	const parts = hostname.split(".");
	if (parts.length !== 4) return false;
	const octets = parts.map((part) => Number.parseInt(part, 10));
	if (
		octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
	)
		return false;
	return (
		octets[0] === 10 ||
		octets[0] === 127 ||
		(octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
		(octets[0] === 192 && octets[1] === 168) ||
		(octets[0] === 169 && octets[1] === 254) ||
		octets[0] === 0
	);
}

function isPrivateIpv6(hostname: string): boolean {
	const normalized = hostname.toLowerCase();
	return (
		normalized === "::1" ||
		normalized.startsWith("fc") ||
		normalized.startsWith("fd") ||
		normalized.startsWith("fe80:")
	);
}

function validateHttpsUrl(url: string): URL | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (parsed.protocol !== "https:") return null;
	if (!hostname || PRIVATE_HOSTNAMES.has(hostname)) return null;
	if (isPrivateIpv4(hostname) || isPrivateIpv6(hostname)) return null;
	return parsed;
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
	const fetchImpl = options.fetchImpl ?? fetch;
	let currentUrl = validateHttpsUrl(source.url);
	if (!currentUrl) return failure("Image URL is not an allowed HTTPS URL.");

	for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
		const response = await fetchImpl(currentUrl, { redirect: "manual" });
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location) return failure("Image redirect is missing a target.");
			currentUrl = validateHttpsUrl(new URL(location, currentUrl).toString());
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
	fetchImpl?: typeof fetch;
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
