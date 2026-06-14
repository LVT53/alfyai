import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { resetKnowledgeBaseState } from "$lib/server/services/cleanup";
import {
	deleteKnowledgeArtifactsByAction,
	type KnowledgeBulkAction,
} from "$lib/server/services/knowledge";
import type { RequestHandler } from "./$types";

type KnowledgeAction = KnowledgeBulkAction | "forget_everything";

function isValidAction(value: unknown): value is KnowledgeAction {
	return (
		value === "forget_all_documents" ||
		value === "forget_all_results" ||
		value === "forget_all_workflows" ||
		value === "forget_everything"
	);
}

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;

	const body = await event.request.json().catch(() => null);
	const action =
		body && typeof body === "object"
			? (body as Record<string, unknown>).action
			: null;
	if (!isValidAction(action)) {
		return json({ error: "Invalid knowledge action payload" }, { status: 400 });
	}

	try {
		if (action === "forget_everything") {
			const result = await resetKnowledgeBaseState(user.id);
			return json({
				success: true,
				deletedArtifactIds: result.deletedArtifactIds,
				message: "Knowledge Base memory and artifacts were reset.",
			});
		}

		const result = await deleteKnowledgeArtifactsByAction(user.id, action);
		const labels: Record<KnowledgeBulkAction, string> = {
			forget_all_documents: "documents",
			forget_all_results: "results",
			forget_all_workflows: "workflows",
		};
		return json({
			success: true,
			deletedArtifactIds: result.deletedArtifactIds,
			message: result.deletedArtifactIds.length
				? `Removed all ${labels[action]} from the Knowledge Base.`
				: `There were no ${labels[action]} to remove.`,
		});
	} catch (error) {
		console.error("[KNOWLEDGE_ACTIONS] Failed to apply action:", {
			userId: user.id,
			action,
			error,
		});
		return json(
			{ error: "Failed to update the Knowledge Base." },
			{ status: 500 },
		);
	}
};
