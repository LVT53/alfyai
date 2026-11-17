<script lang="ts">
/**
 * The message box while a sent message is edited (`MessageInput.svelte`): the
 * quiet strip at the top of the box, its pencil, how many later replies will
 * go (the warning colour) and Cancel; under it the box's own row, holding the
 * message being edited.
 */
import { Brain, Pencil, Plug, Plus, Send } from "@lucide/svelte";
import DrawnBar from "$lib/components/drawings/DrawnBar.svelte";
import { t } from "$lib/i18n";
</script>

<div class="composer">
	<div class="strip">
		<span class="drawn-ic" style:--ic="7"><Pencil size="100%" strokeWidth={2} aria-hidden="true" /></span>
		<span class="label">{$t('chat.editLaterReplies', { count: 2 })}</span>
		<span class="cancel">{$t('common.cancel')}</span>
	</div>
	<div class="row">
		<span class="face"><span class="drawn-ic"><Plus size="100%" strokeWidth={2.2} aria-hidden="true" /></span></span>
		<span class="field"><DrawnBar width="72%" /></span>
		<span class="face"><span class="drawn-ic"><Plug size="100%" strokeWidth={2.1} aria-hidden="true" /></span></span>
		<span class="face"><span class="drawn-ic"><Brain size="100%" strokeWidth={2.1} aria-hidden="true" /></span></span>
		<span class="send"><span class="drawn-ic"><Send size="100%" strokeWidth={2} aria-hidden="true" /></span></span>
	</div>
</div>

<style>
	.composer {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--border-default);
		border-radius: calc(var(--u) * 11);
		background: color-mix(in srgb, var(--surface-elevated) 82%, var(--surface-page) 18%);
		box-shadow: var(--shadow-md);
	}

	.strip {
		display: flex;
		align-items: center;
		gap: calc(var(--u) * 4);
		margin: calc(var(--u) * 5) calc(var(--u) * 7) 0;
		padding: 0 0 calc(var(--u) * 4);
		border-bottom: 1px solid var(--border-subtle);
		color: var(--warning-text);
	}

	.label {
		flex: 1;
		font-size: calc(var(--u) * 6.5);
		font-weight: 600;
		white-space: nowrap;
	}

	.cancel {
		padding: calc(var(--u) * 1.5) calc(var(--u) * 5);
		border: 1px solid var(--border-default);
		border-radius: calc(var(--u) * 6);
		color: var(--text-secondary);
		font-size: calc(var(--u) * 6);
		font-weight: 600;
	}

	.row {
		display: flex;
		align-items: center;
		gap: calc(var(--u) * 4);
		height: calc(var(--u) * 30);
		padding: 0 calc(var(--u) * 6);
	}

	.field {
		display: flex;
		flex: 1;
		min-width: 0;
		padding-left: calc(var(--u) * 2);
	}

	.face {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		width: calc(var(--u) * 19);
		height: calc(var(--u) * 19);
		color: var(--icon-muted);
	}

	.send {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		width: calc(var(--u) * 21);
		height: calc(var(--u) * 21);
		margin-left: calc(var(--u) * 2);
		border: 1px solid color-mix(in srgb, var(--accent) 38%, transparent);
		border-radius: calc(var(--u) * 7);
		background: var(--accent-tint);
		color: var(--accent-text);
	}
</style>
