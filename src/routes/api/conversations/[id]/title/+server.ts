// src/routes/api/conversations/[id]/title/+server.ts
import type { RequestEvent } from "@sveltejs/kit";
import {
	createJsonErrorResponse,
	createJsonResponse,
} from "$lib/server/api/responses";
import { updateConversationTitle } from "$lib/server/services/conversations";
import { generateTitle } from "$lib/server/services/title-generator";

export async function POST({ request, params, locals }: RequestEvent) {
	try {
		if (process.env.PLAYWRIGHT_TEST === "1") {
			return createJsonResponse({ title: null });
		}

		const { userMessage, assistantResponse } = await request.json();
		const userId = locals.user?.id;
		const userTitleLanguage = locals.user?.titleLanguage;
		if (!userId) {
			return createJsonErrorResponse("Unauthorized", 401);
		}

		console.info("[TITLE_GENERATE] Starting title generation", {
			conversationId: params.id,
			userTitleLanguage,
			userMessagePreview: userMessage.slice(0, 80),
		});

		const title = await generateTitle(
			userMessage,
			assistantResponse,
			userTitleLanguage,
		);

		console.info("[TITLE_GENERATE] Title generated", {
			conversationId: params.id,
			userTitleLanguage,
			titlePreview: title.slice(0, 80),
		});

		await updateConversationTitle(userId, params.id, title);
		return createJsonResponse({ title });
	} catch (error) {
		console.error("[TITLE_GENERATE] Failed to generate title", {
			conversationId: params.id,
			error,
		});
		return createJsonResponse({ title: null });
	}
}
