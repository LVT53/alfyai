<script lang="ts">
// The preview renderer, standing in for DocumentPreviewRenderer.svelte: a report
// it shows hands the panel its read-aloud source, as ReportReadAloud.svelte does.
import type { ReportReadingSource } from "$lib/client/read-aloud/controller";
import { fakeReportSource } from "./fake-read-aloud";

let {
	currentPage = $bindable(1),
	totalPages = $bindable(0),
	readAloudReport = null,
}: {
	currentPage?: number;
	totalPages?: number;
	readAloudReport?: {
		fileId: string;
		onSource: (source: ReportReadingSource | null) => void;
	} | null;
	[key: string]: unknown;
} = $props();

$effect(() => {
	const report = readAloudReport;
	if (!report) return;
	report.onSource(fakeReportSource);
	return () => report.onSource(null);
});
</script>

<div
	data-testid="fake-report-preview"
	data-page={currentPage}
	data-pages={totalPages}
	data-report={readAloudReport?.fileId ?? ""}
></div>
