import { get } from "svelte/store";
import { currentConversationId, requestLandingReset } from "$lib/stores/ui";
import { markPreviousConversationId } from "./conversation-session";

/**
 * What every "New chat" button does, in one place.
 *
 * There are three of them — the sidebar's compose icon, the phone header's
 * menu row, and the "New chat" pill in the incognito card — and they used to
 * be three near-copies of the same four lines. They drifted in the way
 * near-copies do: the incognito card's copy was the one place a user could
 * press "New chat" while standing on the landing page itself, and `goto("/")`
 * from "/" does nothing at all. An armed-but-unsent incognito landing had no
 * way out of incognito (2026-09-22 bug report).
 *
 * So navigation is not the whole job. The landing page has state that
 * outlives a navigation to the URL it is already on, and `requestLandingReset`
 * is how it is told to let go of it: the armed incognito flag, and the
 * message-less conversation a typed draft created, which is incognito too if
 * the landing was armed when it was made. Leaving that one attached would put
 * the next message into an incognito conversation under a page that says it is
 * a normal one — the promise broken the other way round.
 *
 * Callers keep whatever else is theirs (closing a menu, collapsing the phone
 * sidebar) and await this for the navigation.
 */
export async function startNewChat(
	navigate: (href: string) => Promise<void>,
): Promise<void> {
	markPreviousConversationId(get(currentConversationId));
	currentConversationId.set(null);
	requestLandingReset();
	await navigate("/");
}
