<script lang="ts">
// A column of unified tool activity rows. Deliberately thin: the open-key set
// lives with the caller (ThinkingBlock), because the same set also drives the
// individual rows the expanded rail interleaves between reasoning steps — one
// open-state source, so a row opened in the live stack is still open when the
// block is expanded.
import type { Snippet } from "svelte";
import type { FileProductionJob } from "$lib/server/services/file-production/types";
import type { DocumentWorkspaceItem } from "$lib/server/services/knowledge/types";
import type { ToolActivityItem } from "$lib/utils/tool-activity";
import ToolActivityRow from "./ToolActivityRow.svelte";

let {
	items,
	openKeys,
	onToggle,
	jobsByKey = undefined,
	onOpenDocument = undefined,
	onRetryJob = undefined,
	onCancelJob = undefined,
	onDismissJob = undefined,
	testId = "tool-activity-list",
	// Rendered directly under a given row — the connector agenda peek / photo
	// strip, which belong to their group's row rather than to the list.
	afterItem = undefined,
}: {
	items: ToolActivityItem[];
	openKeys: Set<string>;
	onToggle: (key: string) => void;
	jobsByKey?: Record<string, FileProductionJob> | undefined;
	onOpenDocument?: ((document: DocumentWorkspaceItem) => void) | undefined;
	onRetryJob?: ((jobId: string) => void) | undefined;
	onCancelJob?: ((jobId: string) => void) | undefined;
	onDismissJob?: ((jobId: string) => void) | undefined;
	testId?: string;
	afterItem?: Snippet<[ToolActivityItem]> | undefined;
} = $props();
</script>

<div class="tool-activity-list" data-testid={testId}>
	{#each items as item (item.key)}
		<ToolActivityRow
			{item}
			open={openKeys.has(item.key)}
			{onToggle}
			job={jobsByKey?.[item.key]}
			{onOpenDocument}
			{onRetryJob}
			{onCancelJob}
			{onDismissJob}
		/>
		{@render afterItem?.(item)}
	{/each}
</div>

<style>
	.tool-activity-list {
		display: flex;
		flex-direction: column;
		gap: 1px;
		width: 100%;
		min-width: 0;
	}
</style>
