/**
 * Incognito, one-way (docs/plans/incognito-one-way-spec.md §2) — when the
 * landing page's mask button is on screen.
 *
 * The rule is "no message has been SENT yet", not "no conversation exists
 * yet". Those look like the same moment and are not: the landing page creates
 * its conversation from the first keystroke (draft persistence) and from the
 * first attachment, so a rule keyed on the prepared conversation's id took the
 * button away the instant the user started typing — which is the instant most
 * people think "wait, not this one". A conversation with no messages in it has
 * had nothing learned from it, which is exactly the condition the server's
 * empty-conversation PATCH allows (spec §1), so arming one in place is honest.
 *
 * This lives here, next to `layout-title.ts`, because it is the gate on the
 * only control that can arm incognito, and a gate worth being able to state
 * and test on its own. Note what is NOT a parameter: the prepared
 * conversation's id. Its absence is the rule.
 */
export function shouldShowIncognitoArm(params: {
	/**
	 * True from the top of the landing page's send handler onward, and never
	 * false again — the point after which nothing about this conversation is
	 * undecided any more.
	 */
	messageSendStarted: boolean;
	/** Already armed: the button has done its job and fades out. */
	armed: boolean;
}): boolean {
	return !params.messageSendStarted && !params.armed;
}
