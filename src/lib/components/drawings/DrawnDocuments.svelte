<script lang="ts">
/**
 * The Knowledge Base's Documents tab (`DocumentsList.svelte`): the row of kind
 * chips, in the order of its filter (All, Documents, Canvas, Apps, Images,
 * Files), and the first rows of the list, each a kind's icon, a name and a
 * date as grey lines. The chips carry the icons the list's own Name column
 * uses, which are not all the artifact cards' (a canvas is a dashboard here).
 */
import {
	AppWindow,
	Image,
	LayoutDashboard,
	Paperclip,
	SquarePen,
} from "@lucide/svelte";
import type { Component } from "svelte";
import type { I18nKey } from "$lib/i18n";
import DrawnBar from "./DrawnBar.svelte";
import DrawnChip from "./DrawnChip.svelte";

const CHIPS: readonly { word: I18nKey; icon?: Component }[] = [
	{ word: "knowledge.documents.filter.all" },
	{ word: "knowledge.documents.filter.document", icon: SquarePen },
	{ word: "knowledge.documents.filter.canvas", icon: LayoutDashboard },
	{ word: "knowledge.documents.filter.app", icon: AppWindow },
	{ word: "knowledge.documents.filter.image", icon: Image },
	{ word: "knowledge.documents.filter.uploaded", icon: Paperclip },
];

const ROWS: readonly { icon: Component; name: string; when: string }[] = [
	{ icon: SquarePen, name: "58%", when: "30%" },
	{ icon: Image, name: "44%", when: "34%" },
];
</script>

<div class="drawn-documents">
	<div class="chips">
		{#each CHIPS as chip, index (chip.word)}
			<DrawnChip word={chip.word} icon={chip.icon} active={index === 0} />
		{/each}
	</div>
	<div class="list">
		{#each ROWS as row}
			<div class="row">
				<span class="drawn-ic kind"><row.icon size="100%" strokeWidth={2} aria-hidden="true" /></span>
				<span class="name"><DrawnBar width={row.name} /></span>
				<DrawnBar width={row.when} tone="soft" />
			</div>
		{/each}
	</div>
</div>

<style>
	.drawn-documents {
		display: flex;
		flex-direction: column;
		gap: calc(var(--u) * 5);
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: calc(var(--u) * 3);
	}

	.list {
		border: 1px solid var(--border-default);
		border-radius: calc(var(--u) * 5);
		background: var(--surface-elevated);
	}

	.row {
		display: flex;
		align-items: center;
		gap: calc(var(--u) * 6);
		height: calc(var(--u) * 15);
		padding: 0 calc(var(--u) * 7);
	}

	.row + .row {
		border-top: 1px solid var(--border-subtle);
	}

	.kind {
		--ic: 9;
		color: var(--icon-muted);
	}

	.name {
		display: flex;
		flex: 1;
		min-width: 0;
	}
</style>
