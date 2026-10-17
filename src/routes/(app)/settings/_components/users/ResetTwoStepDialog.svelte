<script lang="ts">
import { TriangleAlert } from "@lucide/svelte";
import DialogShell from "$lib/components/ui/DialogShell.svelte";
import Spinner from "$lib/components/ui/Spinner.svelte";
import { t } from "$lib/i18n";
import PasswordField from "../PasswordField.svelte";
import { twoStepErrorMessage } from "../two-step-errors";

/**
 * An admin turns another person's two-step sign-in off (spec §3.3). The copy
 * names the person and never assumes a pronoun; the admin proves it with
 * their own password, and with their own code when they have a factor.
 *
 * The action is never offered — and the route refuses it — on the admin's own
 * account, so this dialog has no self case.
 */
let {
	userName,
	adminHasTwoStep,
	onClose,
	onConfirm,
}: {
	userName: string;
	adminHasTwoStep: boolean;
	onClose: () => void;
	onConfirm: (input: { password: string; code?: string }) => Promise<void>;
} = $props();

let password = $state("");
let showPassword = $state(false);
let code = $state("");
let submitting = $state(false);
let error = $state("");

const canSubmit = $derived(
	password.length > 0 && (!adminHasTwoStep || code.trim().length > 0),
);

async function submit() {
	if (!canSubmit || submitting) return;
	submitting = true;
	error = "";
	try {
		await onConfirm({
			password,
			...(adminHasTwoStep ? { code: code.trim() } : {}),
		});
		onClose();
	} catch (failure) {
		error = twoStepErrorMessage(failure, $t);
	} finally {
		submitting = false;
	}
}
</script>

<DialogShell
	title={$t('admin.users.twoStepResetTitle', { name: userName })}
	onClose={onClose}
	maxWidthClass="max-w-[30rem]"
	zIndexClass="z-[9999]"
	phonePresentation="sheet"
>
	<form
		class="reset-two-step"
		onsubmit={(event) => {
			event.preventDefault();
			void submit();
		}}
	>
		<p class="reset-line">{$t('admin.users.twoStepResetMessage')}</p>

		<PasswordField
			id="reset-two-step-password"
			label={$t('admin.yourPassword')}
			bind:value={password}
			bind:shown={showPassword}
			autocomplete="current-password"
			placeholder={$t('admin.yourPassword')}
		/>

		{#if adminHasTwoStep}
			<div>
				<label class="reset-label" for="reset-two-step-code">
					{$t('admin.users.twoStepYourCode')}
				</label>
				<input
					id="reset-two-step-code"
					type="text"
					class="settings-input"
					autocomplete="one-time-code"
					inputmode="numeric"
					maxlength="6"
					spellcheck="false"
					bind:value={code}
					oninput={() => (error = '')}
					placeholder="000000"
				/>
			</div>
		{/if}

		{#if error}
			<p class="reset-error" role="alert">
				<TriangleAlert size={13} strokeWidth={2} aria-hidden="true" />
				<span>{error}</span>
			</p>
		{/if}

		<div class="reset-actions">
			<button type="button" class="btn-secondary" onclick={onClose}>
				{$t('common.cancel')}
			</button>
			<button type="submit" class="btn-danger gap-1.5" disabled={!canSubmit || submitting}>
				{#if submitting}
					<Spinner size={14} />
				{/if}
				{$t('admin.users.twoStepReset')}
			</button>
		</div>
	</form>
</DialogShell>

<style>
	.reset-two-step {
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
	}

	.reset-line {
		margin: 0;
		font-size: 0.875rem;
		line-height: 1.55;
		color: var(--text-muted);
	}

	.reset-label {
		display: block;
		margin-bottom: 0.35rem;
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.reset-error {
		display: flex;
		align-items: flex-start;
		gap: 0.4rem;
		margin: 0;
		font-size: 0.8125rem;
		color: var(--danger);
	}

	.reset-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.625rem;
		margin-top: var(--space-sm);
	}
</style>
