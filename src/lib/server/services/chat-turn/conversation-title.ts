// src/lib/server/services/chat-turn/conversation-title.ts
import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import {
	getConversation,
	nameUntitledConversation,
} from "$lib/server/services/conversations";
import { invalidateHomeSummary } from "$lib/server/services/home-summary";
import {
	getLastConversationLanguage,
	listMessageWindow,
} from "$lib/server/services/messages";
import { generateTitle } from "$lib/server/services/title-generator";
import { isUntitledConversationTitle } from "$lib/shared/conversation-title";

// The server names a conversation, because only the server is sure to see its
// turn end. The browser used to ask for the title when its stream finished,
// which left a chat nameless for good when the person clicked away first, the
// tab closed, or the page fell back to polling: the turn went on without a page
// and nothing asked again. `finalizeChatTurn` now starts this after every turn,
// and the title route calls it too, so a page that is still there hears the
// title as soon as it exists. Whichever comes first does the work.
//
// Keyed by conversation and held for one server process, which is all it needs
// to be: the worst a restart can do is let a later turn write the title.
const inFlight = new Map<string, Promise<string | null>>();

// Two turns back is enough to find the exchange that just finished, however a
// retry or a stop left the ones before it.
const LATEST_EXCHANGE_WINDOW = 4;

export function ensureConversationTitle(params: {
	userId: string;
	conversationId: string;
}): Promise<string | null> {
	// Browser tests run with no title model, and a generated title would change
	// the sidebar every spec reads.
	if (process.env.PLAYWRIGHT_TEST === "1") return Promise.resolve(null);

	const running = inFlight.get(params.conversationId);
	if (running) return running;

	const task = nameConversation(params).finally(() => {
		inFlight.delete(params.conversationId);
	});
	inFlight.set(params.conversationId, task);
	return task;
}

async function nameConversation({
	userId,
	conversationId,
}: {
	userId: string;
	conversationId: string;
}): Promise<string | null> {
	const conversation = await getConversation(userId, conversationId);
	if (!conversation) return null;
	if (!isUntitledConversationTitle(conversation.title)) {
		return conversation.title;
	}

	const exchange = await latestExchange(conversationId);
	if (!exchange) return null;

	const languages = await readTitleLanguages(userId);
	// The language the turn named for the conversation after its reply, so the
	// title agrees with the chips; a conversation with none on record gets the
	// deterministic chain inside generateTitle.
	const conversationLanguage = await getLastConversationLanguage(
		conversationId,
		userId,
	).catch(() => null);

	console.info("[TITLE_GENERATE] Starting title generation", {
		conversationId,
		titleLanguage: languages.titleLanguage,
	});
	const title = await generateTitle(
		exchange.userMessage,
		exchange.assistantResponse,
		languages.titleLanguage,
		languages.uiLanguage,
		conversationLanguage,
	);
	console.info("[TITLE_GENERATE] Title generated", {
		conversationId,
		titlePreview: title.slice(0, 80),
	});
	if (isUntitledConversationTitle(title)) return null;

	const named = await nameUntitledConversation(userId, conversationId, title);
	if (!named) {
		// A rename made while the model was working stays, and is the title.
		const current = await getConversation(userId, conversationId);
		return current?.title ?? null;
	}
	// The same 30-second summary a rename lets go of: the new-chat page's Recent
	// row must not wait it out for a new chat's first title.
	invalidateHomeSummary(userId);
	return named.title;
}

async function latestExchange(
	conversationId: string,
): Promise<{ userMessage: string; assistantResponse: string } | null> {
	const { messages } = await listMessageWindow(conversationId, {
		limit: LATEST_EXCHANGE_WINDOW,
	});
	const assistantIndex = messages.findLastIndex(
		(message) => message.role === "assistant",
	);
	if (assistantIndex < 0) return null;
	const userMessage = messages
		.slice(0, assistantIndex)
		.findLast((message) => message.role === "user");
	if (!userMessage) return null;
	return {
		userMessage: userMessage.content,
		assistantResponse: messages[assistantIndex].content,
	};
}

async function readTitleLanguages(userId: string): Promise<{
	titleLanguage: "auto" | "en" | "hu";
	uiLanguage: "en" | "hu";
}> {
	const [row] = await db
		.select({
			titleLanguage: users.titleLanguage,
			uiLanguage: users.uiLanguage,
		})
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	return {
		titleLanguage: (row?.titleLanguage ?? "auto") as "auto" | "en" | "hu",
		uiLanguage: (row?.uiLanguage ?? "en") as "en" | "hu",
	};
}
