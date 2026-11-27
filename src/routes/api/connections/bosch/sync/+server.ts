import { error } from "@sveltejs/kit";
import { acceptBoschUpload } from "$lib/server/services/connections/providers/bosch-flow-bridge";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
	const auth = request.headers.get("authorization") ?? "";
	const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
	const status = await acceptBoschUpload(
		token,
		async () => {
			const reader = request.body?.getReader();
			if (!reader) throw error(400, "Missing ride summary");
			const chunks: Uint8Array[] = [];
			let bytes = 0;
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				bytes += chunk.value.byteLength;
				if (bytes > 750000) {
					await reader.cancel();
					throw error(413, "Ride summary too large");
				}
				chunks.push(chunk.value);
			}
			try {
				return JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch {
				throw error(400, "Invalid ride summary");
			}
		},
		request.headers.get("X-Bosch-Request"),
	);
	return new Response(null, {
		status,
		headers: { "Cache-Control": "no-store" },
	});
};
