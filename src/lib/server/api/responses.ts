const JSON_RESPONSE_HEADERS = { "Content-Type": "application/json" };

export function createJsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: JSON_RESPONSE_HEADERS,
	});
}

export function createJsonErrorResponse(
	error: string,
	status: number,
): Response {
	return createJsonResponse({ error }, status);
}

export function validateJsonBody(
	body: unknown,
):
	| { ok: true; body: Record<string, unknown> }
	| { ok: false; error: string; status: number } {
	if (!body || typeof body !== "object") {
		return { ok: false, error: "Invalid request body", status: 400 };
	}
	return { ok: true, body: body as Record<string, unknown> };
}
