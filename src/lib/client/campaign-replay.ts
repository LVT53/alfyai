import { hasPendingConversationMessage } from "./conversation-session";

export type CampaignDisplayMode = "auto" | "replay";

export function shouldPersistCampaignCompletion(
	mode: CampaignDisplayMode,
): boolean {
	return mode === "auto";
}

/**
 * Whether the app shell may open an announcement by itself on THIS document
 * load. An announcement belongs to an arrival: the reader opened the app, came
 * back to it, reloaded it. It never belongs to a message they have just sent,
 * and a load is not always an arrival: the landing page sends a first message
 * with a full document navigation to the new chat (`HomeSurface.svelte`), which
 * loads the whole shell again. A card opened by that load sits over the turn
 * the reader has just started.
 *
 * `conversationId` is the chat this load is for, if any. The landing hand-off's
 * own record, the first message waiting in this tab for that chat to send it
 * (`conversation-session.ts`), is what says a send is under way, so there is no
 * second flag for the two to disagree about. The chat takes the message up a
 * frame after it mounts: ask while the shell starts, not after a request.
 */
export function mayAutoShowCampaign(
	conversationId: string | null | undefined,
): boolean {
	return !conversationId || !hasPendingConversationMessage(conversationId);
}
