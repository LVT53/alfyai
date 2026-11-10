<script lang="ts">
/**
 * Home's projects row (`HomeProjects.svelte`): a hairline with its title
 * quiet at the right end, then a card for each of the most recent projects,
 * each a folder in the accent, the project's name and its stats as grey lines.
 */
import { Folder } from "@lucide/svelte";
import { t } from "$lib/i18n";
import DrawnBar from "./DrawnBar.svelte";

const NAMES = ["70%", "52%", "62%"] as const;
</script>

<div class="drawn-home-projects">
	<div class="head">
		<span class="rule"></span>
		<span class="title">{$t('home.projectsHeading')}</span>
	</div>
	<div class="grid">
		{#each NAMES as name}
			<span class="card">
				<span class="name">
					<span class="drawn-ic folder"><Folder size="100%" strokeWidth={1.9} aria-hidden="true" /></span>
					<DrawnBar width={name} />
				</span>
				<DrawnBar width="80%" tone="soft" />
			</span>
		{/each}
	</div>
</div>

<style>
	.head {
		display: flex;
		align-items: center;
		gap: calc(var(--u) * 8);
		margin-bottom: calc(var(--u) * 5);
	}

	.rule {
		flex: 1;
		height: 1px;
		background: var(--border-default);
	}

	.title {
		flex: none;
		color: var(--text-muted);
		font-size: calc(var(--u) * 7);
		white-space: nowrap;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: calc(var(--u) * 5);
	}

	.card {
		display: flex;
		flex-direction: column;
		gap: calc(var(--u) * 4);
		min-width: 0;
		padding: calc(var(--u) * 5) calc(var(--u) * 6);
		border: 1px solid var(--border-default);
		border-radius: calc(var(--u) * 5);
	}

	.name {
		display: flex;
		align-items: center;
		gap: calc(var(--u) * 4);
	}

	.folder {
		--ic: 8;
		color: var(--accent);
	}
</style>
