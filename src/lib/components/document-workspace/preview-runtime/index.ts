import {
	getEntryByFilename,
	getEntryByMimeType,
	isGenericMimeType,
	normalizeMimeType,
} from "$lib/shared/file-types";
import {
	determinePreviewFileType,
	getPreviewLanguage,
	type PreviewFileType,
} from "$lib/utils/file-preview";
import type { OfficePreviewRenderResult } from "./office";
// From the leaf module, NOT from "./office": a static import of the renderer
// module would make the `await import("./office")` below split nothing.
import {
	isOfficePreviewKind,
	type OfficePreviewKind,
	type OfficeRuntimeAdapter,
} from "./office/kinds";
import type { TextPreviewRenderResult } from "./text";

export type { OfficePreviewKind, OfficeRuntimeAdapter };
export { isOfficePreviewKind };

export type TextPreviewKind = "csv" | "markdown" | "highlighted";

type BlobPreviewAdapterKind = Exclude<PreviewFileType, "text" | "html">;

export type PreviewRuntimeAdapter =
	| {
			kind: "text";
			blob: Blob;
			text: string;
			textKind: TextPreviewKind;
			language: string | undefined;
	  }
	| {
			kind: "html";
			blob: Blob;
			text: string;
			trustedRuntime: boolean;
	  }
	| {
			kind: BlobPreviewAdapterKind;
			blob: Blob;
	  };

export type PreviewRuntimeResult =
	| {
			status: "ready";
			sourceUrl: string;
			filename: string;
			mimeType: string | null;
			fileType: PreviewFileType;
			blob: Blob;
			adapter: PreviewRuntimeAdapter;
	  }
	| {
			status: "error";
			sourceUrl: string | null;
			error: string;
	  };

export type PreviewRuntimeLoadInput = {
	artifactId: string | null;
	previewUrl?: string | null;
	filename: string;
	mimeType: string | null;
	fetchImpl?: (url: string) => Promise<Response>;
};

export type PreviewSourceInput = Pick<
	PreviewRuntimeLoadInput,
	"artifactId" | "previewUrl"
>;

export type PdfPreviewComponent =
	typeof import("./pdf/PdfPreview.svelte").default;
export type ImagePreviewComponent =
	typeof import("./image/ImagePreview.svelte").default;
export type OfficePreviewReady = Extract<
	OfficePreviewRenderResult,
	{ status: "ready" }
>;

export function resolvePreviewSourceUrl({
	artifactId,
	previewUrl = null,
}: PreviewSourceInput): string | null {
	const explicitPreviewUrl = previewUrl?.trim() || null;
	return (
		explicitPreviewUrl ??
		(artifactId ? `/api/knowledge/${artifactId}/preview` : null)
	);
}

/**
 * Hands a 401 to the app's one session-expiry reaction.
 *
 * The response goes along with the message because the gate's own refusal is
 * discriminated by the `x-session-expired` header rather than by its wording;
 * the message still matters for a route's own "Unauthorized", which never
 * reaches the gate and so carries no header. Reporting happens even when the
 * body turns out to be unreadable, since the header alone is decisive.
 *
 * `$lib/client/api/http` is imported lazily because this module is loaded by
 * the preview renderers and has no other reason to pull the API client into
 * their chunk.
 */
async function reportUnauthorizedPreview(response: Response): Promise<void> {
	let message = "";
	try {
		const text = await response.text();
		const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
		const body = parsed.error ?? parsed.message;
		if (typeof body === "string") message = body;
	} catch {
		// A body we cannot read is still a failed preview — and the header,
		// which is what the gate actually signs its refusal with, is still
		// readable.
	}
	const { reportAuthFailure } = await import("$lib/client/api/http");
	reportAuthFailure(401, message, response);
}

export async function loadPreviewRuntime(
	input: PreviewRuntimeLoadInput,
): Promise<PreviewRuntimeResult> {
	const sourceUrl = resolvePreviewSourceUrl(input);
	if (!sourceUrl) {
		return { status: "error", sourceUrl, error: "Preview not available" };
	}

	try {
		const response = await (input.fetchImpl ?? fetch)(sourceUrl);
		if (!response.ok) {
			// This is the one call site that CONSUMED the old 303-to-login:
			// `fetch` followed the redirect, `response.ok` was true, and an HTML
			// login page went to a renderer as a Blob. The 401 stops that, but
			// only telling the user "Failed to load file" would leave the
			// workspace stuck on an expired session that the rest of the app has
			// already reacted to.
			//
			// Only for a 401, and never allowed to change the outcome: this
			// function's contract is a `PreviewRuntimeResult`, and a body that
			// cannot be read is still a failed preview, not a different one.
			if (response.status === 401) {
				await reportUnauthorizedPreview(response);
			}
			return {
				status: "error",
				sourceUrl,
				error:
					response.status === 404 ? "File not found" : "Failed to load file",
			};
		}

		// PDF.js can issue HTTP range requests when it owns the URL load, but this
		// runtime currently hands renderers a Blob. Passing the source URL through
		// would require a wider renderer contract change, so PDF previews still load
		// the full blob here.
		const blob = await response.blob();
		const mimeType = getEffectiveMimeType(input.mimeType, blob.type);
		const fileType = await resolvePreviewFileType({
			blob,
			filename: input.filename,
			mimeType,
		});
		const adapter = await buildPreviewAdapter({
			blob,
			fileType,
			filename: input.filename,
			mimeType,
			contentSecurityPolicy: readResponseHeader(
				response,
				"content-security-policy",
			),
		});

		return {
			status: "ready",
			sourceUrl,
			filename: input.filename,
			mimeType,
			fileType,
			blob,
			adapter,
		};
	} catch (err) {
		return {
			status: "error",
			sourceUrl,
			error: err instanceof Error ? err.message : "Failed to load file",
		};
	}
}

export async function loadPdfPreviewComponent(): Promise<PdfPreviewComponent> {
	return (await import("./pdf/PdfPreview.svelte")).default;
}

export async function loadImagePreviewComponent(): Promise<ImagePreviewComponent> {
	return (await import("./image/ImagePreview.svelte")).default;
}

export async function renderPreviewTextAdapter(
	adapter: Extract<PreviewRuntimeAdapter, { kind: "text" | "html" }>,
	options: { isDark?: boolean } = {},
): Promise<TextPreviewRenderResult> {
	const { renderTextPreview } = await import("./text");
	return renderTextPreview(adapter, options);
}

export async function renderPreviewOfficeAdapter(
	adapter: OfficeRuntimeAdapter,
): Promise<OfficePreviewRenderResult> {
	const { renderOfficePreview } = await import("./office");
	return renderOfficePreview(adapter);
}

/**
 * Narrows a loaded adapter to the office renderer's. The kinds live in
 * `./office` next to the renderers that consume them (spec row 40), so no
 * caller has to restate the union.
 */
export function isOfficePreviewAdapter(
	adapter: PreviewRuntimeAdapter,
): adapter is OfficeRuntimeAdapter {
	return isOfficePreviewKind(adapter.kind);
}

export async function resolvePreviewFileType({
	blob,
	filename,
	mimeType,
}: {
	blob: Blob;
	filename: string;
	mimeType: string | null;
}): Promise<PreviewFileType> {
	const fileType = determinePreviewFileType(
		isGenericMimeType(mimeType) ? null : mimeType,
		filename,
	);
	return correctTextSelectedBinaryFileType(fileType, blob, filename);
}

export async function correctTextSelectedBinaryFileType(
	fileType: PreviewFileType,
	blob: Blob,
	filename: string,
): Promise<PreviewFileType> {
	if (fileType !== "text") return fileType;

	const peekBuffer = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
	const peekText = new TextDecoder("utf-8").decode(peekBuffer);
	if (peekText.startsWith("%PDF-")) {
		return "pdf";
	}

	if (
		peekBuffer[0] === 0x50 &&
		peekBuffer[1] === 0x4b &&
		peekBuffer[2] === 0x03 &&
		peekBuffer[3] === 0x04 &&
		filename.toLowerCase().endsWith(".pptx")
	) {
		return "pptx";
	}

	return fileType;
}

async function buildPreviewAdapter({
	blob,
	fileType,
	filename,
	mimeType,
	contentSecurityPolicy,
}: {
	blob: Blob;
	fileType: PreviewFileType;
	filename: string;
	mimeType: string | null;
	contentSecurityPolicy: string | null;
}): Promise<PreviewRuntimeAdapter> {
	if (fileType === "text") {
		const text = await blob.text();
		return {
			kind: "text",
			blob,
			text,
			textKind: getTextPreviewKind(mimeType, filename),
			language: getPreviewLanguage(mimeType, filename),
		};
	}

	if (fileType === "html") {
		return {
			kind: "html",
			blob,
			text: await blob.text(),
			trustedRuntime: allowsTrustedHtmlPreviewRuntime(contentSecurityPolicy),
		};
	}

	return {
		kind: fileType,
		blob,
	};
}

function getEffectiveMimeType(
	metadataMimeType: string | null,
	blobMimeType: string | null,
): string | null {
	const metadataMime = normalizeMimeType(metadataMimeType);
	const blobMime = normalizeMimeType(blobMimeType);
	if (!isGenericMimeType(metadataMime)) return metadataMime;
	if (!isGenericMimeType(blobMime)) return blobMime;
	return metadataMime || blobMime || null;
}

function readResponseHeader(response: Response, name: string): string | null {
	return response.headers?.get(name) ?? null;
}

export function allowsTrustedHtmlPreviewRuntime(
	contentSecurityPolicy: string | null,
): boolean {
	const normalized = (contentSecurityPolicy ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
	if (!normalized) return false;

	return [
		"default-src 'none'",
		"img-src https: http: data:",
		"style-src 'unsafe-inline'",
		"script-src 'unsafe-inline'",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
	].every((token) => normalized.includes(token));
}

/**
 * Which text renderer a text preview gets (spec row 72).
 *
 * The extension and the declared MIME each get a vote, and `csv` is asked
 * before `md` — the same precedence the two hand-written checks had. The
 * registry answers both votes, so `.markdown` counts as markdown because it is
 * an alias extension of the `md` entry, not because this function lists it.
 */
function getTextPreviewKind(
	mimeType: string | null,
	filename: string,
): TextPreviewKind {
	const byExtension = getEntryByFilename(filename);
	const byMimeType = getEntryByMimeType(mimeType);
	if (byExtension?.id === "csv" || byMimeType?.id === "csv") return "csv";
	if (byExtension?.id === "md" || byMimeType?.id === "md") return "markdown";
	return "highlighted";
}
