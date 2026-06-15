<script lang="ts">
import { t } from "$lib/i18n";
import DialogShell from "$lib/components/ui/DialogShell.svelte";
import PasswordField from "./PasswordField.svelte";

export type PrivacyAction =
	| "archive"
	| "clearMemory"
	| "clearWorkspace"
	| "deleteAccount";

let {
	action,
	password = $bindable(""),
	error = "",
	loading = false,
	showPassword = $bindable(false),
	onConfirm,
	onCancel,
	onDownloadArchive,
}: {
	action: PrivacyAction;
	password: string;
	error?: string;
	loading?: boolean;
	showPassword: boolean;
	onConfirm: () => void | Promise<void>;
	onCancel: () => void;
	onDownloadArchive?: () => void | Promise<void>;
} = $props();

const isDestructive = $derived(action !== "archive");

function actionTitle(translate: typeof $t): string {
	if (action === "archive") return translate("settings_downloadMyData");
	if (action === "clearMemory")
		return translate("settings_clearMemoryAndKnowledge");
	if (action === "clearWorkspace") return translate("settings_clearWorkspaceData");
	return translate("settings_deleteAccountPrivacy");
}

function actionDescription(translate: typeof $t): string {
	if (action === "archive") return translate("settings_archiveDescription");
	if (action === "clearMemory")
		return translate("settings_clearMemoryDescription");
	if (action === "clearWorkspace")
		return translate("settings_clearWorkspaceDescription");
	return translate("settings_deleteAccountPrivacyDescription");
}

function loadingLabel(translate: typeof $t): string {
	if (action === "archive") return translate("settings_downloadingData");
	if (action === "deleteAccount") return translate("settings_deleting");
	return translate("settings_clearing");
}

function handleConfirm() {
	if (loading || !password) return;
	void onConfirm();
}

function handleKeydown(event: KeyboardEvent) {
	if (event.key === "Enter") {
		event.preventDefault();
		handleConfirm();
	}
}
</script>

<svelte:window onkeydown={handleKeydown} />

<DialogShell
	title={actionTitle($t)}
	description={actionDescription($t)}
	onClose={onCancel}
	maxWidthClass="max-w-[32rem]"
	zIndexClass="z-[9999]"
>
	<div class="max-h-[calc(100vh-2rem)] overflow-y-auto">
		<form
			onsubmit={(event) => {
				event.preventDefault();
				handleConfirm();
			}}
		>
			{#if isDestructive}
				<p class="mb-4 rounded-md border border-border bg-surface-page p-3 text-sm text-text-secondary">
					{$t('settings_downloadBeforeDestructive')}
				</p>
			{/if}
			<p class="mb-1 text-sm font-medium text-text-primary">
				{$t('settings_enterPasswordConfirm')}
			</p>
			<PasswordField
				id="privacy-action-password"
				label={$t('settings_passwordLabel')}
				bind:value={password}
				bind:shown={showPassword}
				autocomplete="current-password"
				placeholder={$t('admin.yourPassword')}
			/>
			{#if error}
				<p class="mb-3 mt-3 text-sm text-danger">{error}</p>
			{/if}
			<div class="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
				<button type="button" class="btn-secondary w-full sm:w-auto" onclick={onCancel}>
					{$t('common.cancel')}
				</button>
				{#if isDestructive}
					<button
						type="button"
						class="btn-secondary w-full whitespace-nowrap sm:w-auto"
						onclick={() => onDownloadArchive?.()}
					>
						{$t('settings_downloadMyData')}
					</button>
				{/if}
				<button
					type="submit"
					class={action === 'deleteAccount' ? 'btn-danger w-full whitespace-nowrap sm:w-auto' : 'btn-secondary w-full whitespace-nowrap sm:w-auto'}
					disabled={loading || !password}
				>
					{loading ? loadingLabel($t) : actionTitle($t)}
				</button>
			</div>
		</form>
	</div>
</DialogShell>
