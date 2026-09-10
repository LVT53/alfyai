<script lang="ts">
// Connections redesign — the fix for the dead end.
//
// A provider whose server-side keys are missing used to say "Ask your
// administrator to set it up" and stop. On a one-person server that is the
// same person, and even on a shared one it never said WHERE. This names the
// exact Administration page and offers to open it — and only offers when the
// person looking is actually an administrator; a member gets the honest
// "ask whoever runs this server" instead of a button that would 403.
import { Info, SlidersHorizontal } from "@lucide/svelte";
import { ADMIN_INTEGRATIONS_HREF } from "$lib/client/connections/wizard-variant";
import { t } from "$lib/i18n";

let {
	body,
	isAdmin = false,
	onOpen,
}: {
	body: string;
	isAdmin?: boolean;
	onOpen?: () => void;
} = $props();
</script>

<div class="notice" data-testid="wizard-not-set-up">
	<span class="notice-icon" aria-hidden="true">
		<Info size={14} strokeWidth={2} />
	</span>
	<p class="notice-body">{body}</p>
</div>

{#if isAdmin}
	<div class="trail" data-testid="wizard-not-set-up-trail">
		<span class="trail-icon" aria-hidden="true">
			<SlidersHorizontal size={14} strokeWidth={2} />
		</span>
		<span class="trail-text">{$t('connections.wizard.notSetUp.trail')}</span>
		<!-- A real href so middle-click and "open in new tab" work, with the
		     click intercepted for an in-app tab switch. -->
		<a
			class="trail-open"
			href={ADMIN_INTEGRATIONS_HREF}
			onclick={(event) => {
				if (!onOpen) return;
				event.preventDefault();
				onOpen();
			}}
		>
			{$t('connections.actions.open')}
		</a>
	</div>
{/if}

<style>
	.notice {
		display: flex;
		align-items: flex-start;
		gap: 0.625rem;
		padding: 0.75rem 0.875rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-default);
		background: var(--surface-overlay);
		margin-bottom: 0.75rem;
	}

	.notice-icon {
		display: inline-flex;
		margin-top: 0.125rem;
		flex-shrink: 0;
		color: var(--text-secondary);
	}

	.notice-body {
		margin: 0;
		font-size: 0.8125rem;
		line-height: 1.5;
		color: var(--text-secondary);
	}

	.trail {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.625rem 0.8125rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-default);
		background: var(--surface-page);
	}

	.trail-icon {
		display: inline-flex;
		flex-shrink: 0;
		color: var(--text-muted);
	}

	.trail-text {
		flex: 1 1 auto;
		min-width: 0;
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.trail-open {
		flex-shrink: 0;
		padding: 0.25rem 0.625rem;
		border-radius: var(--radius-md);
		border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
		font-size: 0.75rem;
		color: var(--accent);
		text-decoration: none;
		transition: background var(--duration-standard);
	}

	.trail-open:hover {
		background: color-mix(in srgb, var(--accent) 10%, transparent);
	}

	.trail-open:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}
</style>
