<script lang="ts">
// The two answers, negative left and positive right as in every dialog. The
// positive says what it does. It turns red only when the reader loses something
// by it. A fragment, so a sheet's footer can lay the buttons out itself.
import { t } from "$lib/i18n";
import type { WriteCardView } from "./write-card-view";

let {
	view,
	busy = false,
	locked = false,
	onApprove,
	onDecline,
}: {
	view: WriteCardView;
	busy?: boolean;
	/** Not answerable just now, for a reason that is not work under way. */
	locked?: boolean;
	onApprove: () => void;
	onDecline: () => void;
} = $props();
</script>

<button
	type="button"
	class="dialog-btn"
	disabled={busy || locked}
	data-testid="write-confirm-decline"
	aria-label={$t('connections.writeConfirm.actionA11y', {
		action: $t('connections.writeConfirm.cancel'),
		title: view.subject,
	})}
	onclick={onDecline}
>
	{$t('connections.writeConfirm.cancel')}
</button>
<button
	type="button"
	class="dialog-btn"
	class:dialog-btn--positive={!view.danger}
	class:dialog-btn--destructive={view.danger}
	disabled={busy || locked}
	data-testid="write-confirm-approve"
	aria-label={$t('connections.writeConfirm.actionA11y', {
		action: view.approveLabel,
		title: view.subject,
	})}
	onclick={onApprove}
>
	{busy ? $t('connections.writeConfirm.busy') : view.approveLabel}
</button>
