<script lang="ts">
import DialogShell from "$lib/components/ui/DialogShell.svelte";
import { t } from "$lib/i18n";

let {
	title,
	message,
	confirmText = undefined,
	cancelText = undefined,
	confirmVariant = "primary",
	initialFocus = "confirm",
	onConfirm,
	onCancel,
	zIndexClass = "z-[130]",
}: {
	title: string;
	message: string;
	confirmText?: string;
	cancelText?: string;
	confirmVariant?: "primary" | "danger";
	/**
	 * The button that has the focus when the dialog opens. The confirm button
	 * unless a caller says otherwise: a dialog for something that cannot be undone
	 * and that opens from the keyboard (one more Enter, or an Enter held down from
	 * the button that opened it, would confirm it) asks for "cancel".
	 */
	initialFocus?: "confirm" | "cancel";
	onConfirm?: () => void;
	onCancel?: () => void;
	zIndexClass?: string;
} = $props();
let confirmBtnRef = $state<HTMLButtonElement | undefined>(undefined);
let cancelBtnRef = $state<HTMLButtonElement | undefined>(undefined);

function handleConfirm() {
	onConfirm?.();
}

function handleCancel() {
	onCancel?.();
}

$effect(() => {
	const target = initialFocus === "cancel" ? cancelBtnRef : confirmBtnRef;
	if (target) {
		target.focus();
	}
});
</script>

<DialogShell title={title} description={message} onClose={handleCancel} {zIndexClass}>
	<div class="flex justify-end gap-md">
		<button
			bind:this={cancelBtnRef}
			type="button"
			class="btn-secondary"
			onclick={handleCancel}
		>
			{cancelText ?? $t('common.cancel')}
		</button>
		<button
			data-testid="confirm-delete"
			bind:this={confirmBtnRef}
			type="button"
			class={confirmVariant === 'danger' ? 'btn-danger' : 'btn-primary'}
			onclick={handleConfirm}
		>
			{confirmText ?? $t('common.confirm')}
		</button>
	</div>
</DialogShell>
