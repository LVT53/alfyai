<script lang="ts">
	import { onDestroy, onMount } from "svelte";
	import { t } from "$lib/i18n";
	import type { SkillSession } from "$lib/types";

	interface Props {
		session: SkillSession;
		busy?: boolean;
		error?: string | null;
		onFinish: () => void | Promise<void>;
		onDismiss: () => void | Promise<void>;
	}

	let { session, busy = false, error = null, onFinish, onDismiss }: Props = $props();

	const latestNoteFailure = $derived(
		session.milestones
			.filter((milestone) => milestone.kind === "failed_note")
			.at(-1),
	);
	const latestNoteFailureMessage = $derived(
		typeof latestNoteFailure?.messageParams.errorMessage === "string"
			? latestNoteFailure.messageParams.errorMessage
			: $t("skillSessions.noteFailureFallback"),
	);

	let panelElement = $state<HTMLElement | null>(null);
	let resizeObserver: ResizeObserver | null = null;
	let heightHost: HTMLElement | null = null;

	function syncPanelHeight() {
		if (!panelElement || typeof window === "undefined") return;
		const host = panelElement.closest<HTMLElement>(".chat-main") ?? panelElement.parentElement;
		if (!host) return;
		heightHost = host;
		host.style.setProperty("--active-skill-session-height", `${panelElement.offsetHeight}px`);
	}

	onMount(() => {
		syncPanelHeight();
		if (typeof ResizeObserver !== "undefined" && panelElement) {
			resizeObserver = new ResizeObserver(syncPanelHeight);
			resizeObserver.observe(panelElement);
		}
		const frame = requestAnimationFrame(syncPanelHeight);
		return () => cancelAnimationFrame(frame);
	});

	onDestroy(() => {
		resizeObserver?.disconnect();
		heightHost?.style.removeProperty("--active-skill-session-height");
	});
</script>

<section bind:this={panelElement} class="skill-session-panel" aria-label={$t("skillSessions.panelLabel")}>
	<div class="skill-session-panel__content">
		<div class="skill-session-panel__identity">
			<span
				class="skill-session-panel__marker"
				class:skill-session-panel__marker--active={session.status === "active"}
				aria-hidden="true"
			></span>
			<h2>{session.skillDisplayName}</h2>
		</div>
		<div class="skill-session-panel__actions">
			<button type="button" onclick={onFinish} disabled={busy}>
				{$t("skillSessions.finish")}
			</button>
			<button type="button" class="secondary" onclick={onDismiss} disabled={busy}>
				{$t("skillSessions.dismiss")}
			</button>
		</div>
	</div>

	{#if latestNoteFailure}
		<p class="skill-session-panel__note-failure" role="status">
			{$t("skillSessions.noteFailure")}: {latestNoteFailureMessage}
		</p>
	{/if}

	{#if error}
		<p class="skill-session-panel__error" role="alert">{error}</p>
	{/if}
</section>

<style>
	.skill-session-panel {
		position: relative;
		z-index: 0;
		width: min(90%, 44rem);
		margin: 0 auto;
		border: 1px solid color-mix(in srgb, var(--accent) 18%, var(--border-default) 82%);
		border-radius: 8px;
		background: color-mix(in srgb, var(--accent) 5%, var(--surface-overlay) 95%);
		box-shadow:
			0 8px 18px color-mix(in srgb, var(--accent) 7%, transparent 93%),
			0 1px 0 color-mix(in srgb, var(--surface-overlay) 72%, transparent 28%) inset;
		padding: 0.45rem 0.55rem 0.45rem 0.65rem;
		color: var(--text-primary);
		backdrop-filter: blur(14px);
	}

	.skill-session-panel__content {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		min-width: 0;
	}

	.skill-session-panel__identity {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}

	.skill-session-panel__marker {
		width: 0.5rem;
		height: 0.5rem;
		flex: 0 0 auto;
		border-radius: 999px;
		background: var(--accent);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 15%, transparent 85%);
		animation: skill-session-marker-pulse 1.5s ease-in-out infinite;
	}

	.skill-session-panel__marker--active {
		background: var(--success);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 18%, transparent 82%);
	}

	h2 {
		min-width: 0;
		margin: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.875rem;
		font-weight: 650;
		line-height: 1.25;
	}

	.skill-session-panel__error {
		margin: 0.45rem 0 0;
		font-size: 0.8125rem;
		color: var(--danger);
	}

	.skill-session-panel__note-failure {
		margin: 0.45rem 0 0;
		border: 1px solid color-mix(in srgb, var(--accent) 28%, transparent 72%);
		border-radius: 7px;
		background: color-mix(in srgb, var(--accent) 8%, transparent 92%);
		padding: 0.35rem 0.45rem;
		font-size: 0.8125rem;
		color: color-mix(in srgb, var(--accent) 72%, var(--text-primary) 28%);
	}

	.skill-session-panel__actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}

	button {
		border: 1px solid var(--accent);
		border-radius: 8px;
		background: var(--accent);
		color: white;
		font: inherit;
		font-size: 0.75rem;
		font-weight: 600;
		padding: 0.3rem 0.5rem;
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			border-color var(--duration-standard) var(--ease-out),
			box-shadow var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out);
	}

	button.secondary {
		border-color: color-mix(in srgb, var(--border-default) 82%, transparent 18%);
		background: color-mix(in srgb, var(--surface-overlay) 58%, transparent 42%);
		color: var(--text-primary);
	}

	button:hover:not(:disabled),
	button:focus-visible:not(:disabled) {
		background: var(--accent-hover);
		border-color: var(--accent-hover);
		transform: translateY(-1px);
	}

	button.secondary:hover:not(:disabled),
	button.secondary:focus-visible:not(:disabled) {
		background: color-mix(in srgb, var(--accent) 12%, var(--surface-overlay) 88%);
		border-color: color-mix(in srgb, var(--accent) 45%, var(--border-default) 55%);
		color: var(--accent);
	}

	button:focus-visible {
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 38%, transparent 62%);
		outline: none;
	}

	button:active:not(:disabled) {
		transform: translateY(0);
	}

	button:disabled {
		cursor: not-allowed;
		opacity: 0.65;
	}

	@keyframes skill-session-marker-pulse {
		0%,
		100% {
			opacity: 0.72;
			transform: scale(0.92);
		}
		50% {
			opacity: 1;
			transform: scale(1);
		}
	}

	:global(.dark) .skill-session-panel {
		background: color-mix(in srgb, var(--accent) 8%, var(--surface-overlay) 92%);
		box-shadow:
			0 10px 22px rgba(0, 0, 0, 0.26),
			0 0 0 1px color-mix(in srgb, var(--accent) 7%, transparent 93%);
	}

	@media (max-width: 640px) {
		.skill-session-panel {
			width: calc(100% - 0.5rem);
			padding: 0.42rem 0.5rem;
		}

		.skill-session-panel__content {
			align-items: flex-start;
			gap: 0.5rem;
		}

		.skill-session-panel__identity {
			min-height: 30px;
		}

		.skill-session-panel__actions {
			flex: 0 0 auto;
		}

		button {
			min-height: 30px;
			padding: 0.25rem 0.42rem;
		}
	}
</style>
