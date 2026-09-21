import { observeSessionFromResponse } from "$lib/stores/session";

export type FetchLike = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

export class ApiError extends Error {
	readonly code?: string;
	readonly errorKey?: string;
	readonly fieldErrors?: Record<string, string>;
	readonly status: number;

	constructor(
		message: string,
		options: {
			code?: string;
			errorKey?: string;
			fieldErrors?: Record<string, string>;
			status: number;
		},
	) {
		super(message);
		this.name = "ApiError";
		this.code = options.code;
		this.errorKey = options.errorKey;
		this.fieldErrors = options.fieldErrors;
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

/**
 * Report what the response says about this tab's session, and hand it straight
 * back. Called by each helper below on a response it has already awaited —
 * deliberately not folded into `performRequest`, because turning that into an
 * `async` function (or chaining a `.then` onto it) would put an extra microtask
 * between `fetch` resolving and the caller seeing it. Component code that
 * renders after one `await tick()` is sensitive to exactly that.
 */
function observed(response: Response): Response {
	observeSessionFromResponse(response);
	return response;
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
			if (typeof message === "string" && message.trim()) {
				return { message, code, errorKey, fieldErrors };
			}
			if (code || errorKey || fieldErrors)
				return { message: fallback, code, errorKey, fieldErrors };
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
	const response = observed(await performRequest(fetchImpl, input, init));
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
	const response = observed(await performRequest(fetchImpl, input, init));
	if (!response.ok) {
		await throwRequestError(response, errorMessage);
	}
}

export async function requestResponse(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	fetchImpl: FetchLike = fetch,
): Promise<Response> {
	return observed(await performRequest(fetchImpl, input, init));
}

export async function requestText(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	errorMessage: string,
	fetchImpl: FetchLike = fetch,
): Promise<string> {
	const response = observed(await performRequest(fetchImpl, input, init));
	if (!response.ok) {
		await throwRequestError(response, errorMessage);
	}
	return response.text();
}
