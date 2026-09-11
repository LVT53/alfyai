<script lang="ts">
/**
 * Recent, as HomeV4A "Compact" draws it: one hairline with "All conversations"
 * quiet at its right end, then three 32px lines of `title · when · one mark`.
 *
 * The mark is the Atlas badge when a report made it, and the message count
 * otherwise — one mark per line, never both, because the badge already implies
 * the conversation had turns.
 *
 * "Running now" is the fourth line and exists only while a job is actually in
 * flight; when none is, the row is simply absent and Recent is three lines.
 * At 390px it wraps rather than truncates, and the 74px progress track comes
 * off because the stage and the elapsed time are the same information for free.
 */
import { Atom, LoaderCircle, MessageSquare } from "@lucide/svelte";
import { t } from "$lib/i18n";
import type {
	HomeRecentConversation,
	HomeRunningJob,
} from "$lib/client/api/home";
import { makeGrammarFormatters } from "$lib/client/connections/status-grammar";
import { uiLanguage } from "$lib/stores/settings";

let {
	recent = [],
	running = null,
	nowSeconds = Math.floor(Date.now() / 1000),
	onAllConversations,
}: {
	recent?: HomeRecentConversation[];
	running?: HomeRunningJob | null;
	nowSeconds?: number;
	onAllConversations?: () => void;
} = $props();

// "2 h ago" has to be "2 órája" in Hungarian, so the times go through the
// Intl.RelativeTimeFormat pair the connections rows already use rather than
// $lib/utils/time's formatRelativeTime — that one is hard-coded to en-US and
// says so in its own call site's comment. Rebuilt when the language changes;
// `nowSeconds` is the reference instant so the whole board moves on one clock.
const formatters = $derived(
	makeGrammarFormatters($uiLanguage, () => nowSeconds * 1000),
);

function when(updatedAt: number): string {
	return formatters.relative(updatedAt);
}

function elapsed(startedAt: number): string {
	const seconds = Math.max(0, nowSeconds - startedAt);
	if (seconds < 60) return $t("home.runningElapsedSeconds", { seconds });
	return $t("home.runningElapsed", { minutes: Math.floor(seconds / 60) });
}
</script>

{#if recent.length > 0 || running}
	<section
		class="home-recent"
		aria-label={$t('home.recentLabel')}
		data-testid="home-recent"
	>
		<div class="home-head">
			<span class="home-head-rule"></span>
			<button
				type="button"
				class="home-head-link"
				onclick={() => onAllConversations?.()}
				data-testid="home-all-conversations"
			>
				{$t('home.allConversations')}
				<svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true">
					<path d="M9 18l6-6-6-6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
				</svg>
			</button>
		</div>

		<div class="home-lines">
			{#each recent as conversation (conversation.id)}
				<a
					class="home-line"
					href={`/chat/${conversation.id}`}
					data-testid="home-recent-line"
				>
					<span class="home-line-title">{conversation.title}</span>
					<span class="home-line-when">· {when(conversation.updatedAt)}</span>
					<span class="home-line-mark">
						{#if conversation.atlasFinished}
							<span class="home-atlas-badge" data-testid="home-atlas-badge">
								<Atom size={9} strokeWidth={2} />
								{$t('home.atlasBadge')}
							</span>
						{:else}
							<MessageSquare size={10} strokeWidth={1.75} />
							{conversation.messageCount}
						{/if}
					</span>
				</a>
			{/each}

			{#if running}
				<a
					class="home-line home-line-running"
					href={`/chat/${running.conversationId}`}
					data-testid="home-running-line"
				>
					<span class="home-line-kicker">
						<LoaderCircle size={11} strokeWidth={2} class="home-spin" />
						<span class="home-kicker-long">{$t('home.runningNow')}</span>
						<span class="home-kicker-short">{$t('home.runningNowShort')}</span>
					</span>
					<span class="home-line-title">{running.title}</span>
					<span class="home-line-when home-running-stage" data-testid="home-running-stage">
						· {running.phase}
					</span>
					<span class="home-line-mark">
						<span
							class="home-progress"
							role="progressbar"
							aria-valuenow={running.progressPercent}
							aria-valuemin="0"
							aria-valuemax="100"
							aria-label={$t('home.runningProgress', { percent: running.progressPercent })}
						>
							<b style={`width:${running.progressPercent}%`}></b>
						</span>
						{elapsed(running.startedAt)}
					</span>
				</a>
			{/if}
		</div>
	</section>
{/if}

<style>
	.home-recent {
		margin-top: 22px;
	}

	.home-head {
		display: flex;
		align-items: center;
		gap: 14px;
		margin-bottom: 6px;
	}

	.home-head-rule {
		flex: 1 1 auto;
		height: 1px;
		min-width: 20px;
		background: var(--border-default);
	}

	.home-head-link {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 0.72rem;
		color: var(--text-muted);
		opacity: 0.6;
		white-space: nowrap;
		text-decoration: none;
		background: none;
		border: none;
		padding: 2px 2px;
		cursor: pointer;
		transition: opacity 140ms ease;
	}

	.home-head-link:hover,
	.home-head-link:focus-visible {
		opacity: 1;
		color: var(--accent);
	}

	/* The quiet link is 0.72rem of ink; on a phone it still gets a 44px target. */
	@media (max-width: 767px) {
		.home-head-link {
			position: relative;
			min-height: 30px;
		}

		.home-head-link::after {
			content: '';
			position: absolute;
			inset: -7px -8px;
		}
	}

	/* A recent line is a row, so it gets the app's row treatment — the same
	   rounded, tokened hover UsersTable gives its rows, rather than a
	   square-cornered wash that appears and vanishes instantly.

	   The hairline between lines is a ::before rather than a `border-top`
	   because a border and a radius on the same box draw the separator curving
	   down into the corners; as a pseudo-element the rule stays a straight
	   hairline while the hover background keeps its radius. `box-sizing:
	   border-box` is already global, so the 32px row height is unchanged. */
	.home-line {
		position: relative;
		display: flex;
		align-items: center;
		gap: 9px;
		height: 32px;
		padding: 0 6px;
		font-size: 0.82rem;
		color: var(--text-primary);
		min-width: 0;
		text-decoration: none;
		border-radius: var(--radius-md);
		transition: background-color var(--duration-standard) var(--ease-out);
	}

	.home-line::before {
		content: '';
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		height: 1px;
		background: var(--border-subtle);
		pointer-events: none;
	}

	.home-line:first-child::before {
		display: none;
	}

	.home-line:hover {
		background: color-mix(in srgb, var(--surface-elevated) 70%, transparent);
	}

	.home-line:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	.home-line-title {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.home-line-when {
		color: var(--text-muted);
		font-size: 0.74rem;
		white-space: nowrap;
		flex-shrink: 0;
	}

	.home-line-mark {
		margin-left: auto;
		flex-shrink: 0;
		font-size: 0.7rem;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}

	.home-atlas-badge {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 1px 8px;
		border-radius: 9999px;
		font-size: 0.6rem;
		font-weight: 600;
		white-space: nowrap;
		color: var(--accent);
		background: color-mix(in srgb, var(--accent) 14%, transparent);
	}

	.home-line-kicker {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		flex-shrink: 0;
		font-size: 0.7rem;
		font-weight: 600;
		letter-spacing: 0.03em;
		color: var(--accent);
		white-space: nowrap;
	}

	.home-kicker-short {
		display: none;
	}

	.home-line-kicker :global(.home-spin) {
		animation: home-spin 1.1s linear infinite;
	}

	@keyframes home-spin {
		to {
			transform: rotate(360deg);
		}
	}

	.home-progress {
		width: 74px;
		height: 4px;
		border-radius: 2px;
		flex-shrink: 0;
		overflow: hidden;
		background: color-mix(in srgb, var(--text-muted) 18%, transparent);
	}

	.home-progress b {
		display: block;
		height: 100%;
		border-radius: 2px;
		background: var(--accent);
	}

	/* At 390px the running line takes the title on its first row and the stage
	   and the elapsed time on a second, and the 74px track comes off because
	   "Curating sources" is the same information for free. */
	@media (max-width: 767px) {
		.home-recent {
			margin-top: 20px;
		}

		.home-kicker-long {
			display: none;
		}

		.home-kicker-short {
			display: inline;
		}

		.home-line-running {
			height: auto;
			flex-wrap: wrap;
			row-gap: 2px;
			padding: 5px 6px;
		}

		.home-line-running .home-running-stage {
			flex-basis: 100%;
			padding-left: 2px;
		}

		.home-line-running .home-line-mark {
			margin-left: 0;
		}

		.home-line-running .home-progress {
			display: none;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.home-head-link,
		.home-line {
			transition: none;
		}

		.home-line-kicker :global(.home-spin) {
			animation: none;
		}
	}
</style>
