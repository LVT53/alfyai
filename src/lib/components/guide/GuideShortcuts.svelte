<script lang="ts">
/**
 * The box at the end of the page: the few keys worth knowing, then the slash
 * commands of the message box.
 *
 * The commands are read from the composer's registry, with its own
 * descriptions, so the box cannot drift from what typing `/` offers. The keys
 * are written here and checked against the code that handles them:
 * Ctrl/⌘+K (`Sidebar.svelte`), `/` and Ctrl/⌘+Enter (`MessageInput.svelte`;
 * Enter writes a new line there), and Esc (menus and dialogs). Key names are
 * what the keycaps say, so they are not words to translate.
 *
 * A phone has none of those keys, so the key rows are hidden on a touch-only
 * screen; the commands are typed on any keyboard and stay.
 */
import { STATIC_COMPOSER_COMMANDS } from "$lib/composer-commands";
import { type I18nKey, t } from "$lib/i18n";

const KEYS: readonly { keys: string; description: I18nKey }[] = [
	{ keys: "Ctrl/⌘+K", description: "guide.shortcuts.search" },
	{ keys: "/", description: "guide.shortcuts.focus" },
	{ keys: "Ctrl/⌘+Enter", description: "guide.shortcuts.send" },
	{ keys: "Enter", description: "guide.shortcuts.newLine" },
	{ keys: "Esc", description: "guide.shortcuts.close" },
];

const COMMANDS = STATIC_COMPOSER_COMMANDS.filter(
	(command) => command.availability === "available",
);
</script>

<section
	class="guide-shortcuts"
	aria-labelledby="guide-shortcuts-title"
	data-testid="guide-shortcuts"
>
	<h2 id="guide-shortcuts-title" class="guide-shortcuts__title">
		{$t('guide.shortcuts.title')}
	</h2>

	<dl class="guide-shortcuts__keys" data-testid="guide-shortcut-keys">
		{#each KEYS as key (key.keys)}
			<div class="guide-shortcuts__item guide-shortcuts__item--key">
				<dt><kbd>{key.keys}</kbd></dt>
				<dd>{$t(key.description)}</dd>
			</div>
		{/each}
	</dl>

	<p class="guide-shortcuts__lead">{$t('guide.shortcuts.commandsLead')}</p>

	<dl class="guide-shortcuts__commands" data-testid="guide-shortcut-commands">
		{#each COMMANDS as command (command.id)}
			<div class="guide-shortcuts__item">
				<dt><code>{command.token}</code></dt>
				<dd>{$t(command.descriptionKey as I18nKey)}</dd>
			</div>
		{/each}
	</dl>
</section>

<style>
	.guide-shortcuts {
		margin-top: 0.5rem;
		padding: 1rem 1.25rem 1.25rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		background: var(--surface-elevated);
	}

	.guide-shortcuts__title {
		margin: 0 0 0.75rem;
		font-size: var(--text-lg);
		font-weight: 600;
		line-height: 1.3;
		color: var(--text-primary);
		overflow-wrap: anywhere;
	}

	.guide-shortcuts__keys,
	.guide-shortcuts__commands {
		margin: 0;
	}

	.guide-shortcuts__keys {
		display: grid;
		gap: 0.5rem;
	}

	.guide-shortcuts__commands {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(20rem, 100%), 1fr));
		gap: 0.5rem 1.5rem;
	}

	.guide-shortcuts__item {
		display: flex;
		align-items: baseline;
		gap: 0.75rem;
	}

	.guide-shortcuts__item dt {
		flex: none;
		min-width: 6.5rem;
	}

	.guide-shortcuts__item--key dt {
		min-width: 8rem;
	}

	.guide-shortcuts__item dd {
		flex: 1 1 auto;
		min-width: 0;
		margin: 0;
		font-size: var(--text-sm);
		line-height: 1.45;
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}

	.guide-shortcuts__lead {
		margin: 1rem 0 0.5rem;
		font-size: var(--text-sm);
		line-height: 1.45;
		color: var(--text-muted);
	}

	kbd {
		display: inline-block;
		padding: 0.125rem 0.375rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background: var(--surface-page);
		box-shadow: 0 1px 0 var(--border-default);
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		line-height: 1.3;
		color: var(--text-primary);
		white-space: nowrap;
	}

	code {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		color: var(--text-primary);
		overflow-wrap: anywhere;
	}

	@media (hover: none) and (pointer: coarse) {
		.guide-shortcuts__keys {
			display: none;
		}

		/* The command list opens the box now, so its lead has nothing to be
		   separated from. */
		.guide-shortcuts__lead {
			margin-top: 0;
		}
	}
</style>
