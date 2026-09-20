export type FetchLike = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

export class ApiError extends Error {
	readonly code?: string;
	readonly errorKey?: string;
	readonly fieldErrors?: Record<string, string>;
	/**
	 * The endpoint's `details` object, verbatim and unvalidated. Endpoints use
	 * it to carry the values their `errorKey` interpolates (`fileName`,
	 * `extension`) and the state the client should adopt (`maxFileUploadSize`
	 * on a 413). Optional and untyped on purpose: every reader narrows the one
	 * field it wants, so an endpoint may add a field without touching this.
	 */
	readonly details?: Record<string, unknown>;
	/**
	 * The send gate's per-attachment rows, verbatim off the 422 body. The
	 * streaming client already carries them on its error so the composer can
	 * render a translated sentence per file instead of echoing the server's
	 * English; `/api/chat/send` answers the same body, so the non-streaming
	 * Atlas path has to carry them too or the same refusal reads differently
	 * depending on which client made the request. Left untyped here for the
	 * same reason as `details`: the one reader
	 * (`chat/[conversationId]/_helpers.ts`) validates it structurally.
	 */
	readonly attachmentExtraction?: unknown;
	readonly status: number;

	constructor(
		message: string,
		options: {
			code?: string;
			errorKey?: string;
			fieldErrors?: Record<string, string>;
			details?: Record<string, unknown>;
			attachmentExtraction?: unknown;
			status: number;
		},
	) {
		super(message);
		this.name = "ApiError";
		this.code = options.code;
		this.errorKey = options.errorKey;
		this.fieldErrors = options.fieldErrors;
		this.details = options.details;
		this.attachmentExtraction = options.attachmentExtraction;
		this.status = options.status;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function performRequest(
	fetchImpl: FetchLike,
	input: RequestInfo | URL,
	init: RequestInit | undefined,
): Promise<Response> {
	return init === undefined ? fetchImpl(input) : fetchImpl(input, init);
}

async function throwRequestError(
	response: Response,
	errorMessage: string,
): Promise<never> {
	const error = await readErrorPayload(response, errorMessage);
	throw new ApiError(error.message, {
		code: error.code,
		errorKey: error.errorKey,
		fieldErrors: error.fieldErrors,
		details: error.details,
		attachmentExtraction: error.attachmentExtraction,
		status: response.status,
	});
}

export async function readErrorPayload(
	response: Response,
	fallback: string,
): Promise<{
	message: string;
	code?: string;
	errorKey?: string;
	fieldErrors?: Record<string, string>;
	details?: Record<string, unknown>;
	attachmentExtraction?: unknown;
}> {
	const text = await response.text().catch(() => "");
	if (!text) return { message: fallback };

	try {
		const parsed = JSON.parse(text) as unknown;
		if (isRecord(parsed)) {
			const message = parsed.error ?? parsed.message;
			const code =
				typeof parsed.code === "string" && parsed.code.trim()
					? parsed.code
					: undefined;
			const errorKey =
				typeof parsed.errorKey === "string" && parsed.errorKey.trim()
					? parsed.errorKey
					: undefined;
			const fieldErrors = isRecord(parsed.fieldErrors)
				? Object.fromEntries(
						Object.entries(parsed.fieldErrors).filter(
							(entry): entry is [string, string] =>
								typeof entry[1] === "string",
						),
					)
				: undefined;
			const details = isRecord(parsed.details) ? parsed.details : undefined;
			const attachmentExtraction = Array.isArray(parsed.attachmentExtraction)
				? parsed.attachmentExtraction
				: undefined;
			if (typeof message === "string" && message.trim()) {
				return {
					message,
					code,
					errorKey,
					fieldErrors,
					details,
					attachmentExtraction,
				};
			}
			if (code || errorKey || fieldErrors || details || attachmentExtraction)
				return {
					message: fallback,
					code,
					errorKey,
					fieldErrors,
					details,
					attachmentExtraction,
				};
		}
	} catch {
		// Fall back to raw text below.
	}

	return { message: text.trim() || fallback };
}

export async function requestJson<T>(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	errorMessage: string,
	fetchImpl: FetchLike = fetch,
): Promise<T> {
	const response = await performRequest(fetchImpl, input, init);
	if (!response.ok) {
		await throwRequestError(response, errorMessage);
	}

	try {
		return (await response.json()) as T;
	} catch {
		throw new Error(
			"Received an invalid response from the server. Please try again.",
		);
	}
}

export async function requestVoid(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	errorMessage: string,
	fetchImpl: FetchLike = fetch,
): Promise<void> {
	const response = await performRequest(fetchImpl, input, init);
	if (!response.ok) {
		await throwRequestError(response, errorMessage);
	}
}

export async function requestResponse(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	fetchImpl: FetchLike = fetch,
): Promise<Response> {
	return performRequest(fetchImpl, input, init);
}

export async function requestText(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	errorMessage: string,
	fetchImpl: FetchLike = fetch,
): Promise<string> {
	const response = await performRequest(fetchImpl, input, init);
	if (!response.ok) {
		await throwRequestError(response, errorMessage);
	}
	return response.text();
}
