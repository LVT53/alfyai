export type FileServingMode = "preview" | "download";

export interface FileServingResponsePolicyParams {
	mode: FileServingMode;
	contentLength: number;
	contentType: string;
	filename: string;
	safetyFilenames?: readonly (string | null | undefined)[];
	restrictedPreview?: boolean;
}

export interface FileServingRangeResult {
	status: 200 | 206 | 416;
	body: Uint8Array;
	headers: Record<string, string>;
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
		"Accept-Ranges": "bytes",
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

export function applyFileServingRange(params: {
	body: Uint8Array;
	headers: Record<string, string>;
	rangeHeader?: string | null;
}): FileServingRangeResult {
	const totalLength = params.body.byteLength;
	const range = parseSingleByteRange(params.rangeHeader, totalLength);
	if (!range) {
		return {
			status: 200,
			body: params.body,
			headers: params.headers,
		};
	}

	if (range.unsatisfiable) {
		return {
			status: 416,
			body: new Uint8Array(0),
			headers: {
				...params.headers,
				"Content-Length": "0",
				"Content-Range": `bytes */${totalLength}`,
			},
		};
	}

	const body = params.body.subarray(range.start, range.end + 1);
	return {
		status: 206,
		body,
		headers: {
			...params.headers,
			"Content-Length": body.byteLength.toString(),
			"Content-Range": `bytes ${range.start}-${range.end}/${totalLength}`,
		},
	};
}

function parseSingleByteRange(
	rangeHeader: string | null | undefined,
	totalLength: number,
):
	| { start: number; end: number; unsatisfiable?: false }
	| { unsatisfiable: true }
	| null {
	const range = rangeHeader?.trim();
	if (!range?.startsWith("bytes=") || range.includes(",")) {
		return null;
	}

	const spec = range.slice("bytes=".length).trim();
	const match = /^(\d*)-(\d*)$/.exec(spec);
	if (!match) {
		return null;
	}

	const [, rawStart, rawEnd] = match;
	if (!rawStart && !rawEnd) {
		return null;
	}

	if (totalLength <= 0) {
		return { unsatisfiable: true };
	}

	if (!rawStart) {
		const suffixLength = Number(rawEnd);
		if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
			return null;
		}
		const start = Math.max(totalLength - suffixLength, 0);
		return { start, end: totalLength - 1 };
	}

	const start = Number(rawStart);
	const requestedEnd = rawEnd ? Number(rawEnd) : totalLength - 1;
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(requestedEnd) ||
		start < 0 ||
		requestedEnd < start
	) {
		return null;
	}

	if (start >= totalLength) {
		return { unsatisfiable: true };
	}

	return {
		start,
		end: Math.min(requestedEnd, totalLength - 1),
	};
}
