import { json } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/auth/hooks";
import {
	getAllMetrics,
	resetMetrics,
} from "$lib/server/services/maintenance-metrics";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAdmin(event);
	return json(getAllMetrics());
};

export const DELETE: RequestHandler = async (event) => {
	requireAdmin(event);
	resetMetrics();
	return json({ ok: true });
};
