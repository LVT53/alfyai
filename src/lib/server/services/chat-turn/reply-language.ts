// The language of the reply that was written, for everything the app writes
// AFTER it: the follow-up chips, the rail headline and a generated title.
//
// No code decides the language of a reply before it exists (owner decision,
// 2026-10-13): the model reads the person's message and chooses under
// normal-chat-context.ts's REPLY_LANGUAGE_RULE. What follows the reply reads
// the reply instead: `afterReplyLanguage` (language.ts) is the one reader, and
// this is the one place a turn asks it, so the chips, the rail headline and the
// stored `replyLanguage` of a message can never disagree.
//
// It is also where a turn is made observable (I5), content-free: one
// `[LANGUAGE] ui=<en|hu> reply=<en|hu|unknown>` line per turn, a warning line
// when an account shown in English got a reply read as Hungarian (the failure
// the owner asked never to see), and a counter the stability snapshot reports.
import { getLastReplyLanguage } from "$lib/server/services/messages";
import {
	afterReplyLanguage,
	type ReplyLanguage,
	type SupportedLanguage,
} from "../language";

const LOG_PREFIX = "[LANGUAGE]";

export type TurnReplyLanguage = {
	/** The language the chips, the rail headline and the title are written in. */
	language: SupportedLanguage;
	/**
	 * What the words of the reply said, with the person's message to help
	 * ("unknown" when nothing did): stored on the assistant message as
	 * `replyLanguage`, and what the next turn falls back to.
	 */
	read: ReplyLanguage;
};

/** Counts since the process started; no text, no ids. */
export type ReplyLanguageStats = {
	turnsRead: number;
	unreadCount: number;
	englishAccountHungarianReplyCount: number;
	lastEnglishAccountHungarianReplyAt: number | null;
};

const stats: ReplyLanguageStats = {
	turnsRead: 0,
	unreadCount: 0,
	englishAccountHungarianReplyCount: 0,
	lastEnglishAccountHungarianReplyAt: null,
};

export function getReplyLanguageStats(): ReplyLanguageStats {
	return { ...stats };
}

export function resetReplyLanguageStatsForTests(): void {
	stats.turnsRead = 0;
	stats.unreadCount = 0;
	stats.englishAccountHungarianReplyCount = 0;
	stats.lastEnglishAccountHungarianReplyAt = null;
}

/**
 * Reads the reply of a turn that has just been written and says what to write
 * after it in. Call it once per turn, with the reply as the person gets it and
 * the message it answers; the conversation's earlier replies are looked up here
 * (a failed lookup is no earlier reply, never a failed turn).
 */
export async function resolveTurnReplyLanguage(params: {
	userId: string;
	conversationId: string;
	reply: string;
	latestUserMessage: string;
	uiLanguage?: SupportedLanguage;
}): Promise<TurnReplyLanguage> {
	const previous = await getLastReplyLanguage(
		params.conversationId,
		params.userId,
	).catch(() => null);
	const result = afterReplyLanguage({
		reply: params.reply,
		latestUserMessage: params.latestUserMessage,
		previous,
		uiLanguage: params.uiLanguage,
	});

	const ui = params.uiLanguage ?? "en";
	stats.turnsRead += 1;
	if (result.read === "unknown") stats.unreadCount += 1;
	console.info(`${LOG_PREFIX} ui=${ui} reply=${result.read}`);
	if (ui === "en" && result.read === "hu") {
		stats.englishAccountHungarianReplyCount += 1;
		stats.lastEnglishAccountHungarianReplyAt = Date.now();
		console.warn(
			`${LOG_PREFIX} ui=en reply=hu: an account shown in English got a reply read as Hungarian`,
		);
	}
	return result;
}
