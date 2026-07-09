<script lang="ts">
// Issue 7.4 — Option C: the one-time "connector data may reach a cloud
// model" warning shown by MessageInput.svelte before a send that would
// otherwise hit a third-party cloud model while connector capabilities are
// active. Built on DialogShell (focus trap, Escape-to-cancel, announced via
// role="dialog"/aria-describedby).
import DialogShell from "$lib/components/ui/DialogShell.svelte";
import { t } from "$lib/i18n";

let {
	onCancel,
	onContinue,
	onEnableLocalMode,
}: {
	onCancel: () => void;
	onContinue: () => void | Promise<void>;
	onEnableLocalMode: () => void | Promise<void>;
} = $props();

let busy = $state(false);

async function handleContinue() {
	if (busy) return;
	busy = true;
	try {
		await onContinue();
	} finally {
		busy = false;
	}
}

async function handleEnableLocalMode() {
	if (busy) return;
	busy = true;
	try {
		await onEnableLocalMode();
	} finally {
		busy = false;
	}
}
</script>

<DialogShell
	title={$t('connections.cloudWarning.title')}
	description={$t('connections.cloudWarning.description')}
	onClose={onCancel}
>
	<div class="flex flex-wrap justify-end gap-md">
		<button
			type="button"
			class="btn-secondary"
			disabled={busy}
			onclick={onCancel}
		>
			{$t('common.cancel')}
		</button>
		<button
			type="button"
			class="btn-secondary"
			disabled={busy}
			onclick={handleContinue}
		>
			{$t('connections.cloudWarning.continue')}
		</button>
		<button
			type="button"
			class="btn-primary"
			disabled={busy}
			onclick={handleEnableLocalMode}
		>
			{$t('connections.cloudWarning.enableLocalMode')}
		</button>
	</div>
</DialogShell>
