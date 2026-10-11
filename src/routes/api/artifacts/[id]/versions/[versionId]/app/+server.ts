import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import { getArtifact, getVersionBody } from "$lib/server/services/artifacts";
import { auditAppHtml } from "$lib/server/services/artifacts/app/audit";
import { injectReadOnlyAppBootstrap } from "$lib/server/services/artifacts/app/bootstrap";
import { APP_SANDBOX_HEADERS } from "$lib/server/services/artifacts/app/sandbox-response";
import type { RequestHandler } from "./$types";

// GET /api/artifacts/[id]/versions/[versionId]/app — a SAVED VERSION of an
// App, served to History's preview frame (ruling 76, Q7). It is the App route's
// document with exactly the App route's response headers (`APP_SANDBOX_HEADERS`:
// the one CSP string, `sandbox allow-scripts allow-forms`, `connect-src
// 'none'`, `no-store`; ruling 58), one more place the body comes from, and a
// bridge whose `set` refuses (`injectReadOnlyAppBootstrap`). Nothing about the
// frame, its sandbox, its message protocol or the CSP is new; the preview runs
// the old code against today's saved data and leaves that data alone.
//
// Like the App route: GET only, no parameter varies the response, and a body
// that comes from the artifact's own version row, never from the request.
// Unlike it, this route also refuses to serve a version the current contract
// audit calls a violation (self-navigation, WebRTC; ruling 58): a version
// written before those rules cannot be run now, and History's Code view still
// shows it.
export const GET: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const artifactId = event.params.id;
	const conversationId = event.url.searchParams.get("conversationId");

	const artifact = await getArtifact({
		userId: user.id,
		artifactId,
		conversationId,
	});
	// One reason for absent, foreign, incognito-from-outside, a produced file and
	// a Document or board: a 403 here would confirm an id exists.
	if (!artifact || artifact.kind !== "app") {
		return json({ ok: false, reason: "not_found" }, { status: 404 });
	}
	const body = await getVersionBody({
		userId: user.id,
		artifactId,
		versionId: event.params.versionId,
		conversationId,
	});
	if (body === null || body === "") {
		return json({ ok: false, reason: "not_found" }, { status: 404 });
	}

	if (
		auditAppHtml(body).some(
			(check) => check.severity === "violation" && !check.passed,
		)
	) {
		return json({ ok: false, reason: "not_runnable" }, { status: 422 });
	}

	return new Response(injectReadOnlyAppBootstrap(body), {
		status: 200,
		headers: APP_SANDBOX_HEADERS,
	});
};
