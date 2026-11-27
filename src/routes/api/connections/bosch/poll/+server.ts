import { json } from "@sveltejs/kit";
import { pollBoschQuestion } from "$lib/server/services/connections/providers/bosch-flow-bridge";
import type { RequestHandler } from "./$types";
export const POST: RequestHandler = async ({ request }) => {
	const auth = request.headers.get("Authorization") ?? "";
	const data = await pollBoschQuestion(
		auth.startsWith("Bearer ") ? auth.slice(7) : "",
		request.headers.get("X-Bosch-Failed"),
		request.headers.get("X-Bosch-Protocol"),
		request.headers.get("X-Bosch-Grants"),
		request.headers.get("X-Bosch-Failure-Code"),
	);
	return json(data, {
		status: data ? 200 : 401,
		headers: { "Cache-Control": "no-store" },
	});
};
