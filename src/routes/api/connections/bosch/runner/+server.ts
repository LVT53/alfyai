import runner from "$lib/server/services/connections/providers/bosch-flow-runner-cli.ts?raw";
import type { RequestHandler } from "./$types";
export const GET: RequestHandler = ({ locals }) => {
	if (!locals.user) return new Response(null, { status: 401 });
	return new Response(runner, {
		headers: {
			"Content-Type": "application/javascript; charset=utf-8",
			"Content-Disposition": 'attachment; filename="alfyai-bosch.mjs"',
			"X-Content-Type-Options": "nosniff",
			"Cache-Control": "private, no-store",
		},
	});
};
