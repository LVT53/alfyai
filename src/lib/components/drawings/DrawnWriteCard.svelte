<script lang="ts">
/**
 * The card Alfy asks on before it changes anything in an account
 * (`WriteConfirmCard.svelte`): what it is asking in the accent, the thing the
 * question is about (the account's mark in a tinted tile, its name and the
 * lines under it as grey lines), and the two answers, no on the left and yes
 * on the right. Drawn for an email, the commonest ask: its question and its
 * "Send" are `write-card-view.ts`'s keys for `email.send`, and the tile's icon
 * is the one `BrandIcon.svelte` draws for an email account.
 */
import { Mail } from "@lucide/svelte";
import { t } from "$lib/i18n";
import DrawnBar from "./DrawnBar.svelte";
import DrawnButton from "./DrawnButton.svelte";
</script>

<div class="drawn-write-card">
	<div class="content">
		<span class="question">{$t('connections.writeConfirm.question.emailSend')}</span>
		<div class="thing">
			<span class="tile"><span class="drawn-ic" style:--ic="10"><Mail size="100%" strokeWidth={2} aria-hidden="true" /></span></span>
			<span class="named">
				<DrawnBar width="70%" />
				<DrawnBar width="44%" tone="soft" />
			</span>
		</div>
	</div>
	<div class="actions">
		<DrawnButton variant="dialog" word="connections.writeConfirm.cancel" />
		<DrawnButton variant="positive" word="connections.writeConfirm.approve.emailSend" />
	</div>
</div>

<style>
	.drawn-write-card {
		border: 1px solid var(--border-default);
		border-radius: calc(var(--u) * 8);
		background: var(--surface-page);
		box-shadow: var(--shadow-sm);
	}

	.content {
		display: flex;
		flex-direction: column;
		gap: calc(var(--u) * 5);
		padding: calc(var(--u) * 7) calc(var(--u) * 8);
	}

	.question {
		color: var(--accent-text);
		font-size: calc(var(--u) * 7.5);
		font-weight: 700;
		white-space: nowrap;
	}

	.thing {
		display: flex;
		align-items: center;
		gap: calc(var(--u) * 6);
	}

	.tile {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		width: calc(var(--u) * 18);
		height: calc(var(--u) * 18);
		border-radius: calc(var(--u) * 5);
		background: var(--accent-tint);
		color: var(--accent-text);
	}

	.named {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: calc(var(--u) * 4);
	}

	.actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: calc(var(--u) * 5) calc(var(--u) * 8);
		border-top: 1px solid var(--border-subtle);
	}
</style>
