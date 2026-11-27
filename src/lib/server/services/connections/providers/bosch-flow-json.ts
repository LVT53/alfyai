import { ConnectionHttpError } from "../provider-http";
export async function boschJson(
	response: Response,
	limit: number,
): Promise<Record<string, unknown>> {
	const tooLarge = () =>
		new ConnectionHttpError(
			"Bosch response was too large",
			"response_too_large",
		);
	if (Number(response.headers.get("Content-Length")) > limit) {
		await response.body?.cancel();
		throw tooLarge();
	}
	const reader = response.body?.getReader();
	if (!reader)
		throw new ConnectionHttpError("Missing Bosch response", "invalid_response");
	const chunks: Uint8Array[] = [];
	let size = 0,
		timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		void reader.cancel().catch(() => undefined);
	}, 15000);
	try {
		for (;;) {
			const chunk = await reader.read();
			if (timedOut)
				throw new ConnectionHttpError(
					"Bosch request timed out",
					"request_failed",
				);
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > limit) {
				await reader.cancel();
				throw tooLarge();
			}
			chunks.push(chunk.value);
		}
	} finally {
		clearTimeout(timer);
		reader.releaseLock();
	}
	const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (!data || typeof data !== "object" || Array.isArray(data))
		throw new ConnectionHttpError(
			"Unexpected Bosch response",
			"invalid_response",
		);
	return data as Record<string, unknown>;
}
