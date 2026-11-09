<script lang="ts">
/**
 * The composer, as one row: the "+", a line for the message, the accounts
 * plug, the Thinking brain and Send. These are the faces of `MessageInput.svelte`'s
 * bar, drawn as it draws them: a bare icon on the bar, the "+" in the accent
 * while its menu is open, Send as the primary button.
 */
import { Brain, Plug, Plus, Send } from "@lucide/svelte";
import DrawnBar from "./DrawnBar.svelte";
import { isLit } from "./drawing-spot";

let {
	lit = null,
	spots = {},
	menuOpen = false,
}: {
	lit?: string | null;
	/** The spot id the Thinking brain carries. */
	spots?: { thinking?: string };
	/** The "+" menu is open, so the "+" is in the accent. */
	menuOpen?: boolean;
} = $props();
</script>

<div class="drawn-composer">
	<span class="face plus" class:on={menuOpen}>
		<span class="drawn-ic"><Plus size="100%" strokeWidth={2.2} aria-hidden="true" /></span>
	</span>
	<span class="field"><DrawnBar width="55%" tone="soft" /></span>
	<span class="face">
		<span class="drawn-ic"><Plug size="100%" strokeWidth={2.1} aria-hidden="true" /></span>
	</span>
	<span
		class="face"
		data-drawing-spot={spots.thinking}
		class:drawing-spot-lit={isLit(spots.thinking, lit)}
	>
		<span class="drawn-ic"><Brain size="100%" strokeWidth={2.1} aria-hidden="true" /></span>
	</span>
	<span class="send">
		<span class="drawn-ic"><Send size="100%" strokeWidth={2} aria-hidden="true" /></span>
	</span>
</div>

<style>
	.drawn-composer {
		display: flex;
		align-items: center;
		gap: calc(var(--u) * 4);
		height: calc(var(--u) * 32);
		padding: 0 calc(var(--u) * 6);
		border: 1px solid var(--border-default);
		border-radius: calc(var(--u) * 11);
		background: color-mix(in srgb, var(--surface-elevated) 82%, var(--surface-page) 18%);
		box-shadow: var(--shadow-md);
	}

	.field {
		display: flex;
		flex: 1;
		min-width: 0;
		padding-left: calc(var(--u) * 2);
	}

	/* One face: a bare icon on the bar, in the muted colour. */
	.face {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		width: calc(var(--u) * 19);
		height: calc(var(--u) * 19);
		border-radius: 50%;
		color: var(--icon-muted);
	}

	/* The "+" rests a shade quieter and takes the accent while its menu is open. */
	.plus {
		color: var(--text-muted);
	}

	.plus.on {
		color: var(--accent);
	}

	/* Send is the primary button: the accent tint, its text colour and border. */
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
