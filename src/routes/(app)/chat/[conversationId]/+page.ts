import { redirect } from "@sveltejs/kit";
import { browser } from "$app/environment";
import { hasPendingConversationMessage } from "$lib/client/conversation-session";
import type { ConversationDetail } from "$lib/types";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({
	params,
	fetch,
	url,
	parent,
	depends,
}) => {
	const { conversationId } = params;
	depends(`app:conversation-detail:${conversationId}`);
	const useBootstrap =
		url.searchParams.get("view") === "bootstrap" ||
		(browser && typeof window !== "undefined"
			? hasPendingConversationMessage(conversationId)
			: false);
	const detailView = useBootstrap ? "bootstrap" : "first-render";

	const detailPromise = fetch(
		`/api/conversations/${conversationId}?view=${detailView}`,
	);
	const parentDataPromise = parent();
	const [parentData, res] = await Promise.all([
		parentDataPromise,
		detailPromise,
	]);

	if (res.status === 404 || res.status === 500) {
		throw redirect(302, "/");
	}

	if (!res.ok) {
		throw redirect(302, "/");
	}

	const detail: ConversationDetail = await res.json();

	return {
		...parentData,
		conversation: detail.conversation,
		messages: detail.messages,
		attachedArtifacts: detail.attachedArtifacts ?? [],
		activeWorkingSet: detail.activeWorkingSet ?? [],
		contextStatus: detail.contextStatus ?? null,
		contextSources: detail.contextSources ?? null,
		taskState: detail.taskState ?? null,
		contextDebug: detail.contextDebug ?? null,
		draft: detail.draft ?? null,
		forkOrigin: detail.forkOrigin ?? null,
		bootstrap: detail.bootstrap ?? false,
		generatedFiles: detail.generatedFiles ?? [],
		fileProductionJobs: detail.fileProductionJobs ?? [],
		contextCompressionSnapshots: detail.contextCompressionSnapshots ?? [],
		activeSkillSession: detail.activeSkillSession ?? null,
		totalCostUsdMicros: detail.totalCostUsdMicros ?? 0,
		totalTokens: detail.totalTokens ?? 0,
		sidecarPending: detail.sidecarPending ?? false,
	};
};
