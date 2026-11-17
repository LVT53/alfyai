// Which standard report a reading is of, and its HTML as the panel's preview served
// it, by that preview's own rules (spec §4.13). A report is reached two ways: from a
// chat, as a chat file (`/api/chat/files/[id]/preview`), and from the Knowledge
// library, as a library item (`/api/knowledge/[id]/preview`). The session route
// checks the words read against what this returns, so a reading reaches exactly the
// report the panel showed, and only for a person the preview itself would show it to.

import { readStandardReportHtml } from "$lib/server/services/generated-file-serving";
import { resolveWorkingDocumentFileServing } from "$lib/server/services/knowledge/store/working-document-file-serving";
import type { ReportAddress } from "$lib/shared/read-aloud/report-address";

/**
 * The report's HTML as written (without the bridge the preview adds), or null:
 * another person's report, a library item or file the preview does not serve as a
 * standard report (the one profile whose preview runs scripts), one it cannot read.
 */
export async function readReportHtml(params: {
	userId: string;
	report: ReportAddress;
}): Promise<string | null> {
	if ("fileId" in params.report)
		return readStandardReportHtml({
			userId: params.userId,
			fileId: params.report.fileId,
		});
	const served = await resolveWorkingDocumentFileServing({
		userId: params.userId,
		artifactId: params.report.artifactId,
		mode: "preview",
	});
	if (
		!served.ok ||
		served.status !== 200 ||
		!("previewProfile" in served) ||
		served.previewProfile !== "standard-report"
	)
		return null;
	return Buffer.from(served.body).toString("utf8");
}
