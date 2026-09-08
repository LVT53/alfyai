<script lang="ts">
// An Atlas report as ONE unified tool activity row. This replaces the old
// AtlasCard (orbit animation, ATLAS eyebrow, tooltip cluster, basis markers):
// a report is a deliverable the assistant produced, so it reads in the same
// grammar as every other deliverable in the chat —
//
//   [spinner] [file] Atlas report  Ireland's grid …  4 of 6 questions · 6 min
//
// while it runs (pinned, always open, its plan visible in the body), folding to
// a tick with a chevron when it lands.
//
// The row chrome is the shared ToolActivityRow; only the body is Atlas's own
// (AtlasActivityBody), threaded in as its `bodyContent` snippet.
import type {
	AtlasAction,
	AtlasJobCard,
	AtlasProfile,
} from "$lib/server/services/atlas/public-types";
import type { DocumentWorkspaceItem } from "$lib/server/services/knowledge/types";
import { t } from "$lib/i18n";
import {
	buildAtlasActivityItem,
	parseAtlasActivityDetails,
} from "$lib/utils/tool-activity";
import AtlasActivityBody from "./AtlasActivityBody.svelte";
import ToolActivityRow from "./ToolActivityRow.svelte";

let {
	job,
	onOpenDocument = undefined,
	onCancel = undefined,
	onLifecycleAction = undefined,
}: {
	job: AtlasJobCard;
	onOpenDocument?:
		| ((
				document: DocumentWorkspaceItem,
				options?: {
					preservePresentation?: boolean;
					presentation?: "docked" | "expanded";
				},
		  ) => void)
		| undefined;
	onCancel?: ((jobId: string) => void) | undefined;
	onLifecycleAction?:
		| ((payload: {
				jobId: string;
				action: AtlasAction;
				message: string;
				profile: AtlasProfile;
		  }) => void)
		| undefined;
} = $props();

const isActive = $derived(job.status === "queued" || job.status === "running");

// The row's "· 6 min" is live while the job runs, so the clock ticks once a
// second — the same arrangement FileProductionCard uses for its elapsed label.
let nowMs = $state(Date.now());
$effect(() => {
	if (!isActive || typeof window === "undefined") return;
	const interval = window.setInterval(() => {
		nowMs = Date.now();
	}, 1000);
	return () => window.clearInterval(interval);
});

const details = $derived(parseAtlasActivityDetails(job.progress?.details));
const item = $derived(buildAtlasActivityItem(job, details, $t, nowMs));

// A settled report opens on its Report tab by default — the document row with
// Open and Download is the point of the row, and the mockup shows it open. The
// user can fold it away; that choice is remembered for this job.
let userOpen = $state<boolean | null>(null);
const open = $derived(userOpen ?? true);

function handleToggle() {
	userOpen = !open;
}
</script>

<div class="atlas-activity" data-testid="atlas-activity-row" data-status={job.status}>
	<ToolActivityRow {item} {open} onToggle={handleToggle}>
		{#snippet bodyContent()}
			<AtlasActivityBody
				{job}
				{details}
				{onOpenDocument}
				{onCancel}
				{onLifecycleAction}
			/>
		{/snippet}
	</ToolActivityRow>
</div>

<style>
	.atlas-activity {
		display: flex;
		flex-direction: column;
		width: 100%;
		min-width: 0;
		/* Un-clipped, like every activity list: the Download menu is absolutely
		   positioned inside the body and hangs past its edge. */
		overflow: visible;
	}
</style>
