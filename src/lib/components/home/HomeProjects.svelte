<script lang="ts">
/**
 * The home projects row (§M6): up to three cards for the most recently active
 * projects, between the composer and the Recent list.
 *
 * It replaces the Try suggestion chips, and it is deliberately a plainer thing
 * than they were — a card names something the user made and can go back to,
 * where a chip proposed something the user might say. Every figure on a card is
 * already in the database: the name, whether the project has instructions, how
 * many files it knows about, how many chats it holds and when the newest of
 * them was touched.
 *
 * Two rules live elsewhere on purpose.
 *
 * "A project with no chats gets no card" belongs to `listRecentlyActiveProjects`
 * (Slice D), which is the single definition of a project's recent activity. This
 * component draws the list it is handed and filters nothing: re-applying that
 * rule here would be a second, quietly drifting copy of it.
 *
 * The "3 hours ago" comes down as `formatRelative`, the same Intl-backed pair
 * the project page's stats line and the recent list use. A card that built its
 * own would be the third relative-time vocabulary on one screen, and the one
 * that would still say "3 hour ago" in Hungarian.
 */
import { Folder, Paperclip, Pencil } from "@lucide/svelte";
import type { HomeProjectCard } from "$lib/client/api/home";
import { t } from "$lib/i18n";

let {
	projects = [],
	formatRelative,
}: {
	projects?: HomeProjectCard[];
	/** Unix seconds to a phrase in the reader's language. */
	formatRelative: (unixSeconds: number) => string;
} = $props();

function statsLabel(project: HomeProjectCard): string {
	return $t(project.chatCount === 1 ? "projects.statsOne" : "projects.stats", {
		count: project.chatCount,
		relative: formatRelative(project.lastActivityAt),
	});
}

function filesLabel(count: number): string {
	return $t(count === 1 ? "projects.filesLabelOne" : "projects.filesLabel", {
		count,
	});
}
</script>

{#if projects.length > 0}
	<section
		class="home-projects"
		aria-label={$t('home.projectsHeading')}
		data-testid="home-projects"
	>
		<div class="home-projects-head">
			<span class="home-projects-rule"></span>
			<span class="home-projects-title" data-testid="home-projects-heading">
				{$t('home.projectsHeading')}
			</span>
		</div>

		<div class="home-projects-grid">
			{#each projects as project (project.id)}
				<a
					class="home-project-card"
					href={`/projects/${project.id}`}
					aria-label={$t('projects.openA11y', { name: project.name })}
					data-testid="home-project-card"
				>
					<span class="home-project-name">
						<Folder
							size={14}
							strokeWidth={1.9}
							class="home-project-folder"
							aria-hidden="true"
						/>
						<span class="home-project-label">{project.name}</span>
					</span>

					<span class="home-project-stats" data-testid="home-project-stats">
						{statsLabel(project)}
					</span>

					{#if project.hasInstructions || project.fileCount > 0}
						<span class="home-project-meta">
							{#if project.hasInstructions}
								<span
									class="home-project-indicator"
									data-testid="home-project-instructions"
								>
									<Pencil size={11} strokeWidth={1.9} aria-hidden="true" />
									{$t('projects.instructionsLabel')}
								</span>
							{/if}
							{#if project.hasInstructions && project.fileCount > 0}
								<span class="home-project-separator" aria-hidden="true">·</span>
							{/if}
							{#if project.fileCount > 0}
								<span class="home-project-indicator" data-testid="home-project-files">
									<Paperclip size={11} strokeWidth={1.9} aria-hidden="true" />
									{filesLabel(project.fileCount)}
								</span>
							{/if}
						</span>
					{/if}
				</a>
			{/each}
		</div>
	</section>
{/if}

<style>
	/* Sits where the chips did: under the composer, above Recent, on the same
	   22px rhythm the Recent section uses. */
	.home-projects {
		margin-top: 22px;
	}

	.home-projects-head {
		display: flex;
		align-items: center;
		gap: 14px;
		margin-bottom: 10px;
	}

	.home-projects-rule {
		flex: 1 1 auto;
		height: 1px;
		min-width: 20px;
		background: var(--border-default);
	}

	.home-projects-title {
		flex-shrink: 0;
		font-size: 0.72rem;
		color: var(--text-muted);
		opacity: 0.6;
		white-space: nowrap;
	}

	/* Three columns on a desktop, each able to shrink (minmax(0, 1fr)) so a
	   long project name ellipsises instead of pushing the grid wider. */
	.home-projects-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 10px;
	}

	.home-project-card {
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-width: 0;
		padding: 11px 12px 10px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		text-decoration: none;
		color: var(--text-primary);
		transition: background-color var(--duration-standard) var(--ease-out);
	}

	.home-project-card:hover,
	.home-project-card:focus-visible {
		background: var(--surface-elevated);
	}

	.home-project-card:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	.home-project-name {
		display: flex;
		align-items: center;
		gap: 7px;
		min-width: 0;
		font-size: 0.84rem;
	}

	.home-project-name :global(.home-project-folder) {
		flex-shrink: 0;
		color: var(--accent);
	}

	/* One line, ellipsised: a card is a way back to a project, not a place to
	   read its name in full. */
	.home-project-label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.home-project-stats {
		font-size: 0.72rem;
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.home-project-meta {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 0.72rem;
		color: var(--text-muted);
		opacity: 0.85;
		min-width: 0;
	}

	.home-project-indicator {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		white-space: nowrap;
	}

	/* A phone gets the same cards in a row that scrolls sideways, rather than a
	   single column that pushes Recent off the screen. */
	@media (max-width: 640px) {
		.home-projects {
			margin-top: 20px;
		}

		.home-projects-grid {
			display: flex;
			overflow-x: auto;
			gap: 10px;
			scrollbar-width: thin;
			overscroll-behavior-x: contain;
		}

		.home-project-card {
			min-width: 150px;
			flex: 0 0 150px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.home-project-card {
			transition: none;
		}
	}
</style>
