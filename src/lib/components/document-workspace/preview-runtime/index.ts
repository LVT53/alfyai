import {
	determinePreviewFileType,
	getPreviewLanguage,
	type PreviewFileType,
} from "$lib/utils/file-preview";
import type { OfficePreviewRenderResult } from "./office";
import type { TextPreviewRenderResult } from "./text";

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

const GENERIC_MIME_TYPES = new Set([
	"application/octet-stream",
	"application/download",
]);

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
	adapter: Extract<
		PreviewRuntimeAdapter,
		{ kind: "docx" | "xlsx" | "pptx" | "odt" }
	>,
): Promise<OfficePreviewRenderResult> {
	const { renderOfficePreview } = await import("./office");
	return renderOfficePreview(adapter);
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

function isGenericMimeType(mimeType: string | null): boolean {
	const mime = normalizeMimeType(mimeType);
	return !mime || GENERIC_MIME_TYPES.has(mime);
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

function normalizeMimeType(mimeType: string | null): string | null {
	const mime = mimeType?.split(";")[0]?.trim().toLowerCase() ?? "";
	return mime || null;
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

function getTextPreviewKind(
	mimeType: string | null,
	filename: string,
): TextPreviewKind {
	if (mimeType === "text/csv" || filename.toLowerCase().endsWith(".csv")) {
		return "csv";
	}
	const lowercaseFilename = filename.toLowerCase();
	if (
		mimeType === "text/markdown" ||
		lowercaseFilename.endsWith(".md") ||
		lowercaseFilename.endsWith(".markdown")
	) {
		return "markdown";
	}
	return "highlighted";
}
