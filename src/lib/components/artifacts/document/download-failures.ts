import type { I18nKey } from "$lib/i18n";

/**
 * What a Download that did not reach the reader's disk says, one vocabulary for
 * every place that starts one: the panel's popover (`DownloadSheet.svelte`) and the
 * Knowledge library's rows. `reason` is what `downloadProducedFile` answered
 * (`client/downloads.ts`): the server's own when it refused to start the job, else
 * one of its own (`timeout`, `job_failed`, ...).
 */
export type ExportFailure =
	| "failed"
	| "tooLarge"
	| "noConversation"
	| "timeout";

export function exportFailureOf(reason: string): ExportFailure {
	switch (reason) {
		case "source_too_large":
			return "tooLarge";
		case "no_conversation":
		case "conversation_required":
			return "noConversation";
		case "timeout":
			return "timeout";
		default:
			return "failed";
	}
}

/** The sentence for a failure; an App has its own for "no conversation" and "failed". */
export function exportFailureKey(
	failure: ExportFailure,
	kind: "document" | "app",
): I18nKey {
	switch (failure) {
		case "tooLarge":
			return "artifacts.document.export.tooLarge";
		case "noConversation":
			return kind === "app"
				? "artifacts.app.download.unavailable"
				: "artifacts.document.export.noConversation";
		case "timeout":
			return "artifacts.document.export.timeout";
		case "failed":
			return kind === "app"
				? "artifacts.app.download.failed"
				: "artifacts.document.export.failed";
	}
}
