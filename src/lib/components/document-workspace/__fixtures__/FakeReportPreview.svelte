<script lang="ts">
// The preview renderer, standing in for DocumentPreviewRenderer.svelte: a report it
// shows hands the panel its read-aloud source, named by the address it shows the
// report by, as ReportReadAloud.svelte does.
import type { ReportReadingSource } from "$lib/client/read-aloud/controller";
import {
	type ReportAddress,
	reportAddressOf,
} from "$lib/shared/read-aloud/report-address";
import { resolvePreviewSourceUrl } from "../preview-runtime";
import { fakeReportSource } from "./fake-read-aloud";

let {
	currentPage = $bindable(1),
	totalPages = $bindable(0),
	artifactId = null,
	previewUrl = null,
	readAloudReport = null,
}: {
	currentPage?: number;
	totalPages?: number;
	artifactId?: string | null;
	previewUrl?: string | null;
	readAloudReport?: {
		onSource: (
			reading: { report: ReportAddress; source: ReportReadingSource } | null,
		) => void;
	} | null;
	[key: string]: unknown;
} = $props();

const report = $derived(
	reportAddressOf(resolvePreviewSourceUrl({ artifactId, previewUrl })),
);

$effect(() => {
	const hand = readAloudReport;
	const named = report;
	if (!hand || !named) return;
	hand.onSource({ report: named, source: fakeReportSource });
	return () => hand.onSource(null);
});
</script>

<div
	data-testid="fake-report-preview"
	data-page={currentPage}
	data-pages={totalPages}
	data-report={readAloudReport && report ? JSON.stringify(report) : ""}
></div>
