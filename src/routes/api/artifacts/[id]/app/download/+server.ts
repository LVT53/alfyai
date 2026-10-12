import { randomUUID } from "node:crypto";
import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import { getArtifact } from "$lib/server/services/artifacts";
import {
	ARTIFACT_EXPORT_JOB_ORIGIN,
	submitFileProductionIntake,
} from "$lib/server/services/file-production";
import type { RequestHandler } from "./$types";

/**
 * POST /api/artifacts/[id]/app/download — turns the App's CURRENT stored body
 * into a downloadable `.html` chat file through the file-production engine
 * (spec §5: `produce_file` stays the export engine; Owner decision 7).
 *
 * The HTML that gets base64-encoded here is read FRESH from the artifact row
 * by this handler — never trusted from the request body — so a client that
 * already holds a (possibly stale, possibly tampered) copy of the source for
 * the Code tab cannot make the download diverge from what is actually stored
 * (A6.5). The route accepts no body fields that could carry that HTML; the
 * only inputs are the id in the URL and an optional `conversationId` to widen
 * scope for an incognito conversation's own App, exactly like the served
 * route and the kv route.
 */
export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);

	let requestBody: unknown = {};
	try {
		requestBody = await event.request.json();
	} catch {
		requestBody = {};
	}
	const conversationId =
		requestBody && typeof requestBody === "object"
			? ((requestBody as { conversationId?: unknown }).conversationId ?? null)
			: null;

	const artifact = await getArtifact({
		userId: user.id,
		artifactId: event.params.id,
		conversationId: typeof conversationId === "string" ? conversationId : null,
	});
	if (
		!artifact ||
		artifact.kind !== "app" ||
		typeof artifact.body !== "string"
	) {
		return json({ ok: false, reason: "not_found" }, { status: 404 });
	}
	if (!artifact.conversationId) {
		// A project-linked App (spec §4, no conversation) cannot go through
		// produce_file's intake, which requires one (intake.ts). The card shows
		// artifacts.app.download.unavailable instead of reaching this route at
		// all; this is the honest server-side backstop for that same case.
		return json(
			{ ok: false, reason: "conversation_required" },
			{ status: 422 },
		);
	}

	const base64Html = Buffer.from(artifact.body, "utf8").toString("base64");
	const result = await submitFileProductionIntake({
		userId: user.id,
		// The reader's own export, not a reply's (see the Document export route).
		origin: ARTIFACT_EXPORT_JOB_ORIGIN,
		body: {
			conversationId: artifact.conversationId,
			// One job per press: the Download that asked follows THIS job to its end,
			// and a job an earlier press left failed (no sandbox, a timeout) must not
			// be handed back to every press after it as the same failure.
			idempotencyKey: `app-html:${artifact.id}:${artifact.versionNumber}:${randomUUID()}`,
			requestTitle: `${artifact.title} — app source`,
			sourceMode: "program",
			program: {
				language: "python",
				sourceCode:
					"import base64, pathlib\n" +
					`pathlib.Path('/output/app.html').write_bytes(base64.b64decode('${base64Html}'))\n`,
				filename: "app.html",
			},
			outputs: [{ type: "html" }],
		},
	});

	if (!result.ok) {
		return json({ ok: false, reason: result.code }, { status: result.status });
	}
	return json(
		{ ok: true, job: result.job, reused: result.reused },
		{ status: result.status },
	);
};
