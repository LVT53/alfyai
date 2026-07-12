import { json } from "@sveltejs/kit";
import type { Capability } from "$lib/server/services/connections/registry";
import { requireApiUser } from "./auth";
import { isCapability } from "./capabilities";
import { createJsonErrorResponse } from "./responses";

// Shared seams for the connect-start route family
// (src/routes/api/connections/<provider>/start/+server.ts).
//
// Every credential connect route re-typed the same four steps: auth,
// JSON-parse-or-400, required-field validation, then a catch that mapped a
// provider `*Error`'s `.code` to an HTTP status via the SAME status ladder
// (repeated ~8×). These helpers own that shape once.

// The minimal slice of a SvelteKit RequestEvent these helpers need. Accepting a
// structural type (rather than the route-specific RequestEvent) keeps the
// helpers usable from every start route regardless of its params/route id.
export type ApiEvent = {
	request: Request;
	locals: App.Locals;
	url: URL;
};

// Provider error classes all carry a string `code`. This is the shape
// mapConnectError reads. (ImapError extends Error rather than
// ConnectionHttpError, but still has a `code`, so a structural read works for
// every provider uniformly.)
type CodedError = { code: string };

function errorCode(err: unknown): string | undefined {
	if (err instanceof Error) {
		const code = (err as { code?: unknown }).code;
		if (typeof code === "string") return code;
	}
	return undefined;
}

// The one status ladder, previously inlined in every credential start route:
//   invalid_credentials | invalid_token -> 401
//   invalid_config                      -> 400
//   (anything else / no code)           -> 502
//
// `overrides` maps extra provider-specific codes to their status (e.g.
// OwnTracks' not_configured -> 409, Immich enable-writes' connection_not_found
// -> 404) and takes precedence over the base ladder.
export function mapConnectError(
	err: unknown,
	overrides?: Record<string, number>,
): number {
	const code = errorCode(err);
	if (code && overrides && Object.hasOwn(overrides, code)) {
		return overrides[code];
	}
	switch (code) {
		case "invalid_credentials":
		case "invalid_token":
			return 401;
		case "invalid_config":
			return 400;
		default:
			return 502;
	}
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

// biome-ignore lint/suspicious/noExplicitAny: an error class constructor of any shape
type ErrorClass = new (...args: any[]) => Error;

// Encapsulates the full credential-connect route shape: auth (401 JSON on
// failure), JSON-parse-or-400, field validation via the passed `parse`, calling
// `connect`, and mapping a thrown provider error to a status + message.
//
// - `errorType`  the provider's error class. `err instanceof errorType` decides
//   whether to surface `err.message` (and consult its `.code` for the status)
//   or fall back to `fallbackError` + 502 — exactly mirroring the per-route
//   `err instanceof <Provider>Error ? … : …` checks this replaces.
// - `errorStatusOverrides` extra code->status entries merged over the base
//   ladder (see mapConnectError).
// - `success` shapes the 2xx response; defaults to `json(result)`.
export async function handleCredentialConnect<T, R>(opts: {
	event: ApiEvent;
	parse: (body: Record<string, unknown>) => ParseResult<T>;
	connect: (input: { userId: string; value: T }) => Promise<R>;
	errorType: ErrorClass;
	fallbackError: string;
	errorStatusOverrides?: Record<string, number>;
	success?: (result: R) => Response;
}): Promise<Response> {
	const user = requireApiUser(opts.event);

	let body: unknown;
	try {
		body = await opts.event.request.json();
	} catch {
		return createJsonErrorResponse("Invalid JSON", 400);
	}

	const parsed = opts.parse(
		(body && typeof body === "object" ? body : {}) as Record<string, unknown>,
	);
	if (!parsed.ok) {
		return createJsonErrorResponse(parsed.error, 400);
	}

	try {
		const result = await opts.connect({ userId: user.id, value: parsed.value });
		return opts.success ? opts.success(result) : json(result);
	} catch (err) {
		const isProviderError = err instanceof opts.errorType;
		return createJsonErrorResponse(
			isProviderError ? err.message : opts.fallbackError,
			isProviderError ? mapConnectError(err, opts.errorStatusOverrides) : 502,
		);
	}
}

// The two OAuth start routes (google/onedrive) were byte-for-byte twins: auth,
// parse, filter capabilities to the known set, 400 if none, call connectStart,
// then map `not_configured -> 501 : else 502`. This owns that shape once.
export async function handleOAuthConnectStart<R>(opts: {
	event: ApiEvent;
	connectStart: (input: {
		userId: string;
		origin: string;
		capabilities: Capability[];
	}) => Promise<R>;
	errorType: ErrorClass;
	fallbackError: string;
}): Promise<Response> {
	const user = requireApiUser(opts.event);

	let body: { capabilities?: unknown };
	try {
		body = await opts.event.request.json();
	} catch {
		return createJsonErrorResponse("Invalid JSON", 400);
	}

	const capabilities = Array.isArray(body.capabilities)
		? body.capabilities.filter(isCapability)
		: [];
	if (capabilities.length === 0) {
		return createJsonErrorResponse(
			"capabilities must be a non-empty array of known capabilities",
			400,
		);
	}

	try {
		const result = await opts.connectStart({
			userId: user.id,
			origin: opts.event.url.origin,
			capabilities,
		});
		return json(result);
	} catch (err) {
		const status =
			err instanceof opts.errorType &&
			(err as unknown as CodedError).code === "not_configured"
				? 501
				: 502;
		return createJsonErrorResponse(
			err instanceof Error ? err.message : opts.fallbackError,
			status,
		);
	}
}
