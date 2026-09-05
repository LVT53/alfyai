import { json } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/auth/hooks";
import {
	getToolHealthSnapshot,
	runToolHealthChecks,
} from "$lib/server/services/tool-health";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAdmin(event);
	const snapshot = await getToolHealthSnapshot();
	return json({ snapshot });
};

export const POST: RequestHandler = async (event) => {
	requireAdmin(event);
	const snapshot = await runToolHealthChecks();
	return json({ snapshot });
};
