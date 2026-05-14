export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class ApiError extends Error {
	readonly errorKey?: string;
	readonly status: number;

	constructor(message: string, options: { errorKey?: string; status: number }) {
		super(message);
		this.name = 'ApiError';
		this.errorKey = options.errorKey;
		this.status = options.status;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function performRequest(
	fetchImpl: FetchLike,
	input: RequestInfo | URL,
	init: RequestInit | undefined
): Promise<Response> {
	return init === undefined ? fetchImpl(input) : fetchImpl(input, init);
}

async function readErrorPayload(
	response: Response,
	fallback: string
): Promise<{ message: string; errorKey?: string }> {
	const text = await response.text().catch(() => '');
	if (!text) return { message: fallback };

	try {
		const parsed = JSON.parse(text) as unknown;
		if (isRecord(parsed)) {
			const message = parsed.error ?? parsed.message;
			const errorKey = typeof parsed.errorKey === 'string' && parsed.errorKey.trim()
				? parsed.errorKey
				: undefined;
			if (typeof message === 'string' && message.trim()) {
				return { message, errorKey };
			}
			if (errorKey) return { message: fallback, errorKey };
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
	fetchImpl: FetchLike = fetch
): Promise<T> {
	const response = await performRequest(fetchImpl, input, init);
	if (!response.ok) {
		const error = await readErrorPayload(response, errorMessage);
		throw new ApiError(error.message, {
			errorKey: error.errorKey,
			status: response.status,
		});
	}

	try {
		return (await response.json()) as T;
	} catch {
		throw new Error('Received an invalid response from the server. Please try again.');
	}
}

export async function requestVoid(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	errorMessage: string,
	fetchImpl: FetchLike = fetch
): Promise<void> {
	const response = await performRequest(fetchImpl, input, init);
	if (!response.ok) {
		const error = await readErrorPayload(response, errorMessage);
		throw new ApiError(error.message, {
			errorKey: error.errorKey,
			status: response.status,
		});
	}
}
