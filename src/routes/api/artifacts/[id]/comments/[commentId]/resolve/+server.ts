import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import { resolveComment } from "$lib/server/services/artifacts";
import type { RequestHandler } from "./$types";

// POST /api/artifacts/[id]/comments/[commentId]/resolve — { resolved }
// toggles a thread's status. A foreign artifact and a foreign/missing comment
// both 404 identically (ruling 39's "never confirm existence" rule, same as
// every other route here).
export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const artifactId = event.params.id;
	const commentId = event.params.commentId;
	const conversationId = event.url.searchParams.get("conversationId");

	const payload = (await event.request.json().catch(() => null)) as {
		resolved?: unknown;
	} | null;
	const resolved = payload?.resolved === true;

	const ok = await resolveComment({
		userId: user.id,
		artifactId,
		commentId,
		conversationId,
		resolved,
	});
	if (!ok) {
		return json({ ok: false, reason: "not_found" }, { status: 404 });
	}
	return json({ ok: true });
};
