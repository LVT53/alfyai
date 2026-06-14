export type FileServingMode = "preview" | "download";

export interface FileServingResponsePolicyParams {
	mode: FileServingMode;
	contentLength: number;
	contentType: string;
	filename: string;
	safetyFilenames?: readonly (string | null | undefined)[];
	restrictedPreview?: boolean;
}

const RESTRICTED_PREVIEW_CSP =
	"default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

function hasSvgFilename(filename: string): boolean {
	return filename.toLowerCase().endsWith(".svg");
}

function normalizeServedContentType(params: {
	mode: FileServingMode;
	contentType: string;
	filename: string;
}): string {
	if (params.mode === "preview" && params.contentType === "text/html") {
		return "text/html; charset=utf-8";
	}

	return params.contentType;
}

function isRestrictedPreview(params: {
	mode: FileServingMode;
	contentType: string;
	filename: string;
	safetyFilenames?: readonly (string | null | undefined)[];
	restrictedPreview?: boolean;
}): boolean {
	if (params.mode !== "preview") {
		return false;
	}

	return (
		params.restrictedPreview === true ||
		params.contentType === "text/html; charset=utf-8" ||
		params.contentType === "image/svg+xml" ||
		hasSvgFilename(params.filename) ||
		(params.safetyFilenames ?? []).some(
			(filename) => typeof filename === "string" && hasSvgFilename(filename),
		)
	);
}

export function buildFileServingResponseHeaders(
	params: FileServingResponsePolicyParams,
): Record<string, string> {
	const contentType = normalizeServedContentType(params);
	const headers: Record<string, string> = {
		"Content-Type": contentType,
		"Content-Length": params.contentLength.toString(),
		"Content-Disposition":
			params.mode === "preview"
				? `inline; filename="${encodeURIComponent(params.filename)}"`
				: `attachment; filename*=UTF-8''${encodeURIComponent(params.filename)}`,
		"Cache-Control":
			params.mode === "preview" ? "private, max-age=3600" : "private, no-store",
	};

	if (isRestrictedPreview({ ...params, contentType })) {
		headers["Content-Security-Policy"] = RESTRICTED_PREVIEW_CSP;
		headers["X-Content-Type-Options"] = "nosniff";
		headers["Referrer-Policy"] = "no-referrer";
	}

	return headers;
}
