<script lang="ts">
// The two answers, negative left and positive right as in every dialog. The
// positive says what it does. It turns red only when the reader loses something
// by it. A fragment, so a sheet's footer can lay the buttons out itself.
import { t } from "$lib/i18n";
import type { WriteCardView } from "./write-card-view";

let {
	view,
	busy = false,
	cancelling = false,
	locked = false,
	onApprove,
	onDecline,
}: {
	view: WriteCardView;
	busy?: boolean;
	cancelling?: boolean;
	/** Not answerable just now, for a reason that is not work under way. */
	locked?: boolean;
	onApprove: () => void;
	onDecline: () => void;
} = $props();
const declineLabel = $derived(
	busy && cancelling
		? $t("connections.writeConfirm.progress.cancel")
		: $t("connections.writeConfirm.cancel"),
);
const approveLabel = $derived(
	busy && !cancelling
		? (view.progressLabel ?? $t("connections.writeConfirm.busy"))
		: view.approveLabel,
);
</script>

<button
	type="button"
	class="dialog-btn"
	disabled={busy || locked}
	data-testid="write-confirm-decline"
	aria-label={$t('connections.writeConfirm.actionA11y', {
		action: declineLabel,
		title: view.subject,
	})}
	onclick={onDecline}
>
	{declineLabel}
</button>
<button
	type="button"
	class="dialog-btn"
	class:dialog-btn--positive={!view.danger}
	class:dialog-btn--destructive={view.danger}
	disabled={busy || locked}
	data-testid="write-confirm-approve"
	aria-label={$t('connections.writeConfirm.actionA11y', {
		action: approveLabel,
		title: view.subject,
	})}
	onclick={onApprove}
>
	{approveLabel}
</button>
