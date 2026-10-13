// The language of what the app writes AFTER a reply: the follow-up chips, the
// rail headline and (through the message's record) a generated title.
//
// No code decides the language of a reply before it exists (owner decision,
// 2026-10-13): the model reads the person's message and chooses under
// normal-chat-context.ts's REPLY_LANGUAGE_RULE. What follows the reply is in the
// language of the PERSON, which is not always the reply's (a requested email in
// another language, a translation, a pasted text, an explicit "answer in …"), so
// the model names it too: one small call after the reply (conversation-language.ts).
// If that call fails or answers with anything else, the deterministic chain
// takes over (language.ts's afterReplyLanguage: the reply's own words, the
// conversation's stored language, the account's UI language). This is the one
// place a turn asks, so the chips, the rail headline, the title and the
// message's record can never disagree.
//
// It is also where a turn is made observable (I5), content-free: one
// `[LANGUAGE] ui=<en|hu> conversation=<en|hu> reply=<en|hu|unknown>` line per
// turn, a warning line when an account shown in English, whose person writes
// English, got a reply that reads as Hungarian (the failure the owner asked never
// to see), and counters the stability snapshot reports.
import {
	getLastConversationLanguage,
	getPreviousUserMessageText,
} from "$lib/server/services/messages";
import {
	afterReplyLanguage,
	type ReplyLanguage,
	readReplyLanguage,
	type SupportedLanguage,
} from "../language";
import { readConversationLanguage } from "./conversation-language";

const LOG_PREFIX = "[LANGUAGE]";

export type TurnReplyLanguage = {
	/** The language the chips, the rail headline and the title are written in. */
	language: SupportedLanguage;
	/**
	 * What the words of the reply say by themselves ("unknown" when they say
	 * nothing): the record on the message (`replyLanguage`) and the log, never
	 * what decides.
	 */
	reply: ReplyLanguage;
	/** Whether the model named `language`, or the deterministic chain had to. */
	via: "model" | "fallback";
};

/** Counts since the process started; no text, no ids. */
export type ReplyLanguageStats = {
	turnsRead: number;
	/** Turns whose reply said nothing by itself (code, a table, "Done."). */
	unreadCount: number;
	/** Turns the model did not name the language for: the chain decided. */
	conversationLanguageFallbackCount: number;
	/** An English writer on an English account got a reply that reads Hungarian. */
	englishAccountHungarianReplyCount: number;
	lastEnglishAccountHungarianReplyAt: number | null;
};

const stats: ReplyLanguageStats = {
	turnsRead: 0,
	unreadCount: 0,
	conversationLanguageFallbackCount: 0,
	englishAccountHungarianReplyCount: 0,
	lastEnglishAccountHungarianReplyAt: null,
};

export function getReplyLanguageStats(): ReplyLanguageStats {
	return { ...stats };
}

export function resetReplyLanguageStatsForTests(): void {
	stats.turnsRead = 0;
	stats.unreadCount = 0;
	stats.conversationLanguageFallbackCount = 0;
	stats.englishAccountHungarianReplyCount = 0;
	stats.lastEnglishAccountHungarianReplyAt = null;
}

/**
 * Names the language to write in after the reply of a turn that has just been
 * written. Call it once per turn, with the reply as the person gets it and the
 * message it answers; the conversation's earlier messages are looked up here
 * (a failed lookup is no earlier message, never a failed turn).
 */
export async function resolveTurnReplyLanguage(params: {
	userId: string;
	conversationId: string;
	reply: string;
	latestUserMessage: string;
	uiLanguage?: SupportedLanguage;
}): Promise<TurnReplyLanguage> {
	const [previous, previousUserMessage] = await Promise.all([
		getLastConversationLanguage(params.conversationId, params.userId).catch(
			() => null,
		),
		getPreviousUserMessageText(
			params.conversationId,
			params.userId,
			params.latestUserMessage,
		).catch(() => null),
	]);

	const asked = await readConversationLanguage({
		userId: params.userId,
		conversationId: params.conversationId,
		latestUserMessage: params.latestUserMessage,
		previousUserMessage,
		reply: params.reply,
	}).catch(() => null);

	const language =
		asked ??
		afterReplyLanguage({
			reply: params.reply,
			latestUserMessage: params.latestUserMessage,
			previous,
			uiLanguage: params.uiLanguage,
		});
	const reply = readReplyLanguage(params.reply);

	const ui = params.uiLanguage ?? "en";
	stats.turnsRead += 1;
	if (reply === "unknown") stats.unreadCount += 1;
	if (!asked) stats.conversationLanguageFallbackCount += 1;
	console.info(
		`${LOG_PREFIX} ui=${ui} conversation=${language} reply=${reply}`,
	);
	if (ui === "en" && language === "en" && reply === "hu") {
		stats.englishAccountHungarianReplyCount += 1;
		stats.lastEnglishAccountHungarianReplyAt = Date.now();
		console.warn(
			`${LOG_PREFIX} ui=en conversation=en reply=hu: a person writing English got a reply that reads as Hungarian`,
		);
	}
	return { language, reply, via: asked ? "model" : "fallback" };
}
