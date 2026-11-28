import { error } from "@sveltejs/kit";
import type { z } from "zod";

export const privateSetupHeaders = {
	"Cache-Control": "private, no-store",
	"Referrer-Policy": "no-referrer",
};

export async function readSetupRequest<T>(
	request: Request,
	schema: z.ZodType<T>,
	origin: string,
): Promise<T> {
	if (request.headers.get("origin") !== origin)
		error(403, "Invalid request origin");
	if (
		request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
		"application/json"
	)
		error(415, "JSON required");
	const limit = 32 * 1024;
	if (Number(request.headers.get("content-length")) > limit)
		error(413, "Request too large");
	const reader = request.body?.getReader();
	if (!reader) error(400, "Missing setup request");
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		bytes += value.byteLength;
		if (bytes > limit) {
			await reader.cancel();
			error(413, "Request too large");
		}
		chunks.push(value);
	}
	let body: unknown;
	try {
		body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		error(400, "Invalid JSON");
	}
	const result = schema.safeParse(body);
	if (!result.success) error(400, "Invalid setup request");
	return result.data;
}
