<script module lang="ts">
import { slide } from "svelte/transition";
import { reducedMotionAware } from "$lib/utils/motion";

// Wrapped once per module, like DialogShell's backdrop/panel transitions, so
// every group shares one reduced-motion-aware slide for open AND close.
export const groupSlide = reducedMotionAware(slide);
</script>

<script lang="ts">
import type { Snippet } from "svelte";
import { ChevronDown } from "@lucide/svelte";
import { t } from "$lib/i18n";
import "./system.css";

let {
	title,
	count = undefined,
	open = $bindable(true),
	testId = undefined,
	children,
}: {
	title: string;
	count?: number | undefined;
	open?: boolean;
	testId?: string | undefined;
	children: Snippet;
} = $props();

const bodyId = `sys-group-${Math.random().toString(36).slice(2, 9)}`;
</script>

<section class="sys-card" data-testid={testId}>
	<button
		type="button"
		class="sys-group-head"
		aria-expanded={open}
		aria-controls={bodyId}
		aria-label={open
			? $t('admin.system.advanced.collapse', { group: title })
			: $t('admin.system.advanced.expand', { group: title })}
		onclick={() => (open = !open)}
	>
		<span class="sys-group-chevron">
			<ChevronDown size={15} strokeWidth={2} aria-hidden="true" />
		</span>
		<span>{title}</span>
		{#if count !== undefined}
			<span class="sys-group-count">{$t('admin.system.advanced.keyCount', { count: String(count) })}</span>
		{/if}
	</button>
	{#if open}
		<div id={bodyId} transition:groupSlide={{ duration: 180 }}>
			<div style="padding-top: 12px">
				{@render children()}
			</div>
		</div>
	{/if}
</section>
