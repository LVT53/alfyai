import { json } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/auth/hooks";
import { getEffectiveConfigReport } from "$lib/server/services/admin-effective-config";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAdmin(event);
	const report = await getEffectiveConfigReport();
	return json(report);
};
