import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getDocumentBehaviorKey } from "$lib/server/services/document-resolution";
import { getArtifactsForUser } from "$lib/server/services/knowledge/store";
import { recordMemoryBehaviorEvent } from "$lib/server/services/memory-behavior-log";
import type { RequestHandler } from "./$types";

const DOCUMENT_OPEN_BUCKET_MS = 30 * 60 * 1000;

function isValidAction(value: unknown): value is "workspace_opened" {
	return value === "workspace_opened";
}

export const POST: RequestHandler = async (event) => {
	try {
		requireAuth(event);
	} catch {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	const user = event.locals.user;
	const body = await event.request.json().catch(() => null);
	const payload =
		body && typeof body === "object" ? (body as Record<string, unknown>) : null;
	const artifactId =
		typeof payload?.artifactId === "string" ? payload.artifactId.trim() : "";
	const action = payload?.action ?? null;

	if (!isValidAction(action) || !artifactId) {
		return json(
			{ error: "Invalid document behavior payload" },
			{ status: 400 },
		);
	}

	const [artifact] = await getArtifactsForUser(user.id, [artifactId]);
	if (!artifact) {
		return json({ error: "Artifact not found" }, { status: 404 });
	}

	const subjectId = getDocumentBehaviorKey(artifact);
	const observedAt = Date.now();
	const bucketId = Math.floor(observedAt / DOCUMENT_OPEN_BUCKET_MS);

	await recordMemoryBehaviorEvent({
		eventKey: `document_opened:${subjectId}:${bucketId}`,
		userId: user.id,
		domain: "document",
		eventType: "document_opened",
		conversationId: artifact.conversationId,
		subjectId,
		relatedId: artifact.id,
		observedAt,
		payload: {
			action,
			artifactType: artifact.type,
		},
	});

	return json({ success: true });
};
