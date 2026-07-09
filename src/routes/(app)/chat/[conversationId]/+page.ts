import { redirect } from "@sveltejs/kit";
import { browser } from "$app/environment";
import { hasPendingConversationMessage } from "$lib/client/conversation-session";
import type { ConversationDetail, PendingWrite } from "$lib/types";
import type { PageLoad } from "./$types";

// Issue 7.5 — pending writes are NOT part of ConversationDetail (a separate,
// dedicated endpoint per the write-confirm-card brief), so they're fetched
// in parallel with the main detail request rather than embedded in it. A
// failure here degrades to an empty list rather than redirecting/erroring
// the whole page load — a missing write-confirm card is recoverable (the
// user can still see it after a refresh once the endpoint is healthy again);
// a failed conversation-detail load is not.
async function loadPendingWrites(
	conversationId: string,
	fetchImpl: typeof fetch,
): Promise<PendingWrite[]> {
	try {
		const res = await fetchImpl(
			`/api/conversations/${conversationId}/pending-writes`,
		);
		if (!res.ok) return [];
		const payload = (await res.json()) as { pendingWrites?: PendingWrite[] };
		return Array.isArray(payload.pendingWrites) ? payload.pendingWrites : [];
	} catch {
		return [];
	}
}

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
	const pendingWritesPromise = loadPendingWrites(conversationId, fetch);
	const parentDataPromise = parent();
	const [parentData, res, pendingWrites] = await Promise.all([
		parentDataPromise,
		detailPromise,
		pendingWritesPromise,
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
		atlasJobs: detail.atlasJobs ?? [],
		atlasAvailability: detail.atlasAvailability ?? null,
		contextCompressionSnapshots: detail.contextCompressionSnapshots ?? [],
		activeSkillSession: detail.activeSkillSession ?? null,
		totalCostUsdMicros: detail.totalCostUsdMicros ?? 0,
		totalTokens: detail.totalTokens ?? 0,
		sidecarPending: detail.sidecarPending ?? false,
		pendingWrites,
	};
};
