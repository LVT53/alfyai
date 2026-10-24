// src/routes/api/conversations/[id]/title/+server.ts
import type { RequestEvent } from "@sveltejs/kit";
import {
	createJsonErrorResponse,
	createJsonResponse,
} from "$lib/server/api/responses";
import { updateConversationTitle } from "$lib/server/services/conversations";
import { invalidateHomeSummary } from "$lib/server/services/home-summary";
import { getLastConversationLanguage } from "$lib/server/services/messages";
import { generateTitle } from "$lib/server/services/title-generator";

export async function POST({ request, params, locals }: RequestEvent) {
	try {
		if (process.env.PLAYWRIGHT_TEST === "1") {
			return createJsonResponse({ title: null });
		}

		const { userMessage, assistantResponse } = await request.json();
		const userId = locals.user?.id;
		const userTitleLanguage = locals.user?.titleLanguage;
		const userUiLanguage = locals.user?.uiLanguage;
		if (!userId) {
			return createJsonErrorResponse("Unauthorized", 401);
		}

		console.info("[TITLE_GENERATE] Starting title generation", {
			conversationId: params.id,
			userTitleLanguage,
			userMessagePreview: userMessage.slice(0, 80),
		});

		// The language the turn named for the conversation after its reply, so the
		// title agrees with the chips; a conversation with none on record gets the
		// deterministic chain inside generateTitle.
		const conversationLanguage = await getLastConversationLanguage(
			params.id,
			userId,
		).catch(() => null);
		const title = await generateTitle(
			userMessage,
			assistantResponse,
			userTitleLanguage,
			userUiLanguage,
			conversationLanguage,
		);

		console.info("[TITLE_GENERATE] Title generated", {
			conversationId: params.id,
			userTitleLanguage,
			titlePreview: title.slice(0, 80),
		});

		await updateConversationTitle(userId, params.id, title);
		// The same 30-second summary a rename lets go of: the new-chat page's
		// Recent row must not wait it out for a new chat's first title.
		invalidateHomeSummary(userId);
		return createJsonResponse({ title });
	} catch (error) {
		console.error("[TITLE_GENERATE] Failed to generate title", {
			conversationId: params.id,
			error,
		});
		return createJsonResponse({ title: null });
	}
}
