import {
	STANDARD_REPORT_HANDLER_HASHES,
	STANDARD_REPORT_SCRIPT_HASHES,
} from "$lib/server/services/file-production/renderers/standard-report-scripts";
import { ensureFilenameExtension } from "$lib/shared/file-types/download-name";

export type FileServingMode = "preview" | "download";

export interface FileServingResponsePolicyParams {
	mode: FileServingMode;
	contentLength: number;
	contentType: string;
	filename: string;
	safetyFilenames?: readonly (string | null | undefined)[];
	restrictedPreview?: boolean;
	previewProfile?: FileServingPreviewProfile;
	/**
	 * A standard report's other scripts of the app's own, by their CSP hashes: read
	 * aloud's bridge, when the preview adds it. Ignored for any other profile.
	 */
	reportScriptHashes?: readonly string[];
}

export interface FileServingRangeResult {
	status: 200 | 206 | 416;
	body: Uint8Array;
	headers: Record<string, string>;
}

export type ParsedFileServingRange =
	| { start: number; end: number; unsatisfiable?: false }
	| { unsatisfiable: true }
	| null;

const RESTRICTED_PREVIEW_CSP =
	"default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

/**
 * A generated standard report's preview policy. The report runs script of the app's
 * own (the section menu, the source tooltips, the favicon fallback, read aloud's
 * bridge), and the panel frames the report by this very response
 * (`DocumentPreviewRenderer.svelte`, a sandboxed frame with no same origin), so this
 * header is the policy it runs under.
 *
 * Only the app's own scripts run, by construction (security review I1): `script-src`
 * names them by their hashes (`standard-report-scripts.ts`: the renderer's script,
 * today's and every earlier one a stored report may carry, and its favicon fallback
 * under `'unsafe-hashes'`), plus `extraScriptHashes` (the bridge, hashed when the
 * preview adds it). No `'unsafe-inline'`: no other inline script, handler or
 * `javascript:` address in a stored report runs, whatever it holds. A hash never
 * comes from the file served.
 *
 * Otherwise it is no wider than the others in what it may load: `img-src data:`
 * (ADR-0068). The report's pictures are inlined as data: URIs when it is rendered
 * (`file-production/report-images.ts`), so it never has to fetch one, and a remote
 * address in it would be a request nobody clicked. `allowsTrustedHtmlPreviewRuntime`
 * recognises it by its shape: the same directives exactly, `script-src` hashes only.
 */
export function standardReportPreviewCsp(
	extraScriptHashes: readonly string[] = [],
): string {
	const scripts = [...STANDARD_REPORT_SCRIPT_HASHES, ...extraScriptHashes];
	return `default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src ${scripts.join(" ")} 'unsafe-hashes' ${STANDARD_REPORT_HANDLER_HASHES.join(" ")}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`;
}

export type FileServingPreviewProfile = "standard-report";

/** `encodeURIComponent` leaves ' ( ) * alone, which RFC 5987 does not allow in `filename*`. */
export function encodeRfc5987(value: string): string {
	return encodeURIComponent(value).replace(
		/['()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

/**
 * The one Content-Disposition every file route sends: an ASCII `filename=` fallback
 * (accents folded, quotes, slashes and control characters replaced) for readers
 * that ignore RFC 5987, and `filename*=UTF-8''...` carrying the real name.
 */
export function buildContentDisposition(
	disposition: "attachment" | "inline",
	filename: string,
): string {
	const ascii =
		filename
			.normalize("NFD")
			.replace(/\p{M}+/gu, "")
			// biome-ignore lint/suspicious/noControlCharactersInRegex: strips control characters from a header value
			.replace(/[\u0000-\u001f\u007f"\\/*?:<>|]/g, "_")
			.replace(/[^\x20-\x7e]/g, "_")
			.trim() || "download";
	return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(filename)}`;
}

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
		"Content-Disposition": buildContentDisposition(
			params.mode === "preview" ? "inline" : "attachment",
			params.mode === "preview"
				? params.filename
				: ensureFilenameExtension(params.filename, contentType),
		),
		"Cache-Control":
			params.mode === "preview" ? "private, max-age=3600" : "private, no-store",
	};

	if (isRestrictedPreview({ ...params, contentType })) {
		headers["Content-Security-Policy"] =
			params.previewProfile === "standard-report"
				? standardReportPreviewCsp(params.reportScriptHashes)
				: RESTRICTED_PREVIEW_CSP;
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
	const range = parseFileServingRange(params.rangeHeader, totalLength);
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

	const body = Uint8Array.from(
		params.body.subarray(range.start, range.end + 1),
	);
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

export function parseFileServingRange(
	rangeHeader: string | null | undefined,
	totalLength: number,
): ParsedFileServingRange {
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
