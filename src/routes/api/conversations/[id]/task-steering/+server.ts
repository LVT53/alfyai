import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getConversation } from "$lib/server/services/conversations";
import {
	applyTaskSteeringAction,
	getContextDebugState,
	getConversationTaskState,
} from "$lib/server/services/task-state";
import type { TaskSteeringAction } from "$lib/types";
import type { RequestHandler } from "./$types";

const VALID_ACTIONS = new Set<TaskSteeringAction>([
	"lock_task",
	"unlock_task",
	"start_new_task",
	"set_artifact_preference",
	"pin_artifact",
	"unpin_artifact",
	"exclude_artifact",
	"include_artifact",
]);

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	const conversationId = event.params.id;

	const conversation = await getConversation(user.id, conversationId);
	if (!conversation) {
		return json({ error: "Conversation not found" }, { status: 404 });
	}

	const body = await event.request.json().catch(() => null);
	const action = body?.action;
	const artifactId =
		typeof body?.artifactId === "string" ? body.artifactId : null;
	const objective = typeof body?.objective === "string" ? body.objective : null;
	const preference =
		body?.preference === "auto" ||
		body?.preference === "pinned" ||
		body?.preference === "excluded"
			? body.preference
			: null;

	if (
		typeof action !== "string" ||
		!VALID_ACTIONS.has(action as TaskSteeringAction)
	) {
		return json({ error: "Invalid steering action" }, { status: 400 });
	}

	if (
		(action === "set_artifact_preference" ||
			action === "pin_artifact" ||
			action === "unpin_artifact" ||
			action === "exclude_artifact" ||
			action === "include_artifact") &&
		!artifactId
	) {
		return json(
			{ error: "artifactId is required for artifact actions" },
			{ status: 400 },
		);
	}
	if (action === "set_artifact_preference" && !preference) {
		return json(
			{ error: "preference is required for set_artifact_preference" },
			{ status: 400 },
		);
	}

	const result = await applyTaskSteeringAction({
		userId: user.id,
		conversationId,
		action: action as TaskSteeringAction,
		artifactId,
		objective,
		preference,
	});

	return json({
		taskState:
			result.taskState ??
			(await getConversationTaskState(user.id, conversationId)),
		contextDebug:
			result.contextDebug ??
			(await getContextDebugState(user.id, conversationId)),
	});
};
