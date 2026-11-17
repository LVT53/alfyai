// A clip's GIF download: the one the card's More menu and the panel's Download
// both offer. The server makes the GIF on request (seconds of ffmpeg the first
// time), and its 503 or 500 is a sentence to say, never a file to save, so the
// answer is read before anything is saved.
import { get } from "svelte/store";
import { downloadAuthenticatedBlob } from "$lib/client/downloads";
import { t } from "$lib/i18n";
import { showToast } from "$lib/stores/toast";
import { videoFileUrl } from "./video-card-view";

/** Saves the clip as a GIF; a failure is said in a toast. Resolves whether it started. */
export async function downloadClipAsGif(
	fileId: string,
	options: { conversationId: string | null; title: string },
): Promise<boolean> {
	const started = await downloadAuthenticatedBlob(
		videoFileUrl(fileId, {
			download: true,
			format: "gif",
			conversationId: options.conversationId,
		}),
		{ fallbackFilename: `${options.title || "clip"}.gif` },
	);
	if (!started) {
		showToast({
			type: "error",
			message: get(t)("artifacts.take.actionFailed"),
		});
	}
	return started;
}
