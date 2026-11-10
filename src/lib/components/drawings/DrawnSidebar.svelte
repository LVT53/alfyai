<script lang="ts">
/**
 * The sidebar, expanded (`Sidebar.svelte` and `ConversationList.svelte`): the
 * search pill with the compose and Knowledge Base icons beside it, then the
 * list in its three sections, in the order the list draws them: Pinned,
 * Projects (folders) and Chats. Section heads are the list's small capitals
 * with their chevron and icon; the chats and projects are grey lines. The
 * pill leaves out its shortcut keycap, as the real one does when the sidebar
 * is narrow.
 */
import {
	BookOpen,
	ChevronRight,
	FilePen,
	Folder,
	MessageSquare,
	Pin,
	Search,
} from "@lucide/svelte";
import { t } from "$lib/i18n";
import DrawnBar from "./DrawnBar.svelte";
import { isLit } from "./drawing-spot";

let {
	lit = null,
	spots = {},
}: {
	lit?: string | null;
	/** The spot ids this sidebar carries: its search pill, its Projects head
	 *  and its list (all three sections). */
	spots?: { search?: string; projects?: string; list?: string };
} = $props();
</script>

<div class="drawn-sidebar">
	<div class="top">
		<span
			class="pill"
			data-drawing-spot={spots.search}
			class:drawing-spot-lit={isLit(spots.search, lit)}
		>
			<span class="drawn-ic pill-icon"><Search size="100%" strokeWidth={2.1} aria-hidden="true" /></span>
			<span class="pill-word">{$t('sidebar.search')}</span>
		</span>
		<span class="tool compose"><span class="drawn-ic" style:--ic="10"><FilePen size="100%" strokeWidth={2.1} aria-hidden="true" /></span></span>
		<span class="tool"><span class="drawn-ic" style:--ic="10"><BookOpen size="100%" strokeWidth={2.1} aria-hidden="true" /></span></span>
	</div>

	<div
		class="list"
		data-drawing-spot={spots.list}
		class:drawing-spot-lit={isLit(spots.list, lit)}
	>
		<div class="section">
			<div class="head">
				<span class="drawn-ic chevron"><ChevronRight size="100%" strokeWidth={2.5} aria-hidden="true" /></span>
				<span class="drawn-ic section-icon"><Pin size="100%" strokeWidth={2.4} aria-hidden="true" /></span>
				<span class="head-word">{$t('sidebar.pinned')}</span>
			</div>
			<div class="row"><DrawnBar width="62%" /></div>
		</div>

		<div class="section">
			<div
				class="head"
				data-drawing-spot={spots.projects}
				class:drawing-spot-lit={isLit(spots.projects, lit)}
			>
				<span class="drawn-ic chevron"><ChevronRight size="100%" strokeWidth={2.5} aria-hidden="true" /></span>
				<span class="drawn-ic section-icon"><Folder size="100%" strokeWidth={2.4} aria-hidden="true" /></span>
				<span class="head-word">{$t('sidebar.projects')}</span>
			</div>
			<div class="row project">
				<span class="drawn-ic chevron"><ChevronRight size="100%" strokeWidth={2.5} aria-hidden="true" /></span>
				<span class="drawn-ic folder"><Folder size="100%" strokeWidth={2} aria-hidden="true" /></span>
				<DrawnBar width="50%" />
			</div>
			<div class="row project">
				<span class="drawn-ic chevron"><ChevronRight size="100%" strokeWidth={2.5} aria-hidden="true" /></span>
				<span class="drawn-ic folder"><Folder size="100%" strokeWidth={2} aria-hidden="true" /></span>
				<DrawnBar width="42%" />
			</div>
		</div>

		<div class="section">
			<div class="head">
				<span class="drawn-ic chevron"><ChevronRight size="100%" strokeWidth={2.5} aria-hidden="true" /></span>
				<span class="drawn-ic section-icon"><MessageSquare size="100%" strokeWidth={2.4} aria-hidden="true" /></span>
				<span class="head-word">{$t('sidebar.chats')}</span>
			</div>
			<div class="row open"><DrawnBar width="70%" /></div>
			<div class="row"><DrawnBar width="56%" /></div>
			<div class="row"><DrawnBar width="64%" /></div>
		</div>
	</div>
</div>

<style>
	.drawn-sidebar {
		display: flex;
		flex-direction: column;
		gap: calc(var(--u) * 8);
		height: 100%;
		box-sizing: border-box;
		padding: calc(var(--u) * 10) calc(var(--u) * 8);
		border-right: 1px solid var(--border-default);
		background: var(--surface-overlay);
	}

	.top {
		display: flex;
		align-items: center;
		gap: calc(var(--u) * 3);
	}

	/* The search pill gives way to the icons beside it. */
	.pill {
		display: flex;
		flex: 1;
		align-items: center;
		gap: calc(var(--u) * 4);
		min-width: 0;
		height: calc(var(--u) * 17);
		padding: 0 calc(var(--u) * 5);
		border: 1px solid var(--border-default);
		border-radius: calc(var(--u) * 5);
		color: var(--text-muted);
	}

	.pill-icon {
		--ic: 9;
		color: var(--icon-muted);
	}

	.pill-word {
		flex: 1;
		min-width: 0;
		font-size: calc(var(--u) * 8);
		white-space: nowrap;
	}

	.tool {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		width: calc(var(--u) * 14);
		height: calc(var(--u) * 17);
		color: var(--icon-muted);
	}

	.compose {
		color: var(--accent);
	}

	.list {
		display: flex;
		flex-direction: column;
		gap: calc(var(--u) * 4);
		padding: calc(var(--u) * 1);
		border-radius: calc(var(--u) * 5);
	}

	.head {
		display: flex;
		align-items: center;
		gap: calc(var(--u) * 2.5);
		height: calc(var(--u) * 12);
		padding: 0 calc(var(--u) * 2);
		border-radius: calc(var(--u) * 4);
	}

	.chevron {
		--ic: 6;
		color: var(--icon-muted);
	}

	.section-icon {
		--ic: 7;
		color: var(--icon-muted);
	}

	.head-word {
		color: var(--text-muted);
		font-size: calc(var(--u) * 6.5);
		font-weight: 500;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		white-space: nowrap;
	}

	.row {
		display: flex;
		align-items: center;
		gap: calc(var(--u) * 4);
		height: calc(var(--u) * 13);
		padding: 0 calc(var(--u) * 6);
		border: 1px solid transparent;
		border-radius: calc(var(--u) * 4);
	}

	/* The chat that is open: lifted, with the accent for a border. */
	.row.open {
		border-color: var(--accent);
		background: var(--surface-elevated);
		box-shadow: var(--shadow-sm);
	}

	/* A folder's row: its chevron, then the folder, as `ProjectItem.svelte` sets them. */
	.project {
		gap: calc(var(--u) * 2.5);
		padding-left: calc(var(--u) * 2);
	}

	.folder {
		--ic: 8;
		color: var(--icon-muted);
	}
</style>
