import { goto } from "$app/navigation";
import { appPlacePath } from "$lib/app-places";
import { storeHomeComposerSeed } from "$lib/client/conversation-session";
import { requestSpotlight } from "$lib/stores/spotlight";
import type { GuideAction } from "./guide-content";

/**
 * Try it: leave the example for Home (`conversation-session.ts` owns the
 * hand-off; Home takes it once and puts it in an empty message box, unsent),
 * then go there. The example is stored before the navigation so that Home finds
 * it when it mounts.
 */
export async function tryGuideExample(example: string): Promise<void> {
	storeHomeComposerSeed(example);
	await goto(appPlacePath("home"));
}

/**
 * Show me: ask for the real control to be rung (`stores/spotlight.ts` keeps the
 * request in memory for a few seconds, and the control that carries the id
 * takes it), then go to the page it is on. The request is made first, so the
 * page that opens finds it waiting. A `place` of `null` is a control the
 * sidebar shows on every page, so the person stays where they are.
 */
export async function showGuidePlace(
	action: Extract<GuideAction, { kind: "showMe" }>,
): Promise<void> {
	requestSpotlight(action.spotlight);
	if (action.place !== null) await goto(appPlacePath(action.place));
}
