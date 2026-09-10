<script lang="ts">
import { Check, TriangleAlert } from "@lucide/svelte";
import type { UserRole } from "$lib/server/services/auth-types";
import { t } from "$lib/i18n";
import DialogShell from "$lib/components/ui/DialogShell.svelte";
import PasswordField from "./PasswordField.svelte";

let {
	name = $bindable(""),
	email = $bindable(""),
	password = $bindable(""),
	role = $bindable("user"),
	showPassword = $bindable(false),
	createLoading = false,
	createError = "",
	onConfirm,
	onCancel,
}: {
	name: string;
	email: string;
	password: string;
	role: UserRole;
	showPassword: boolean;
	createLoading?: boolean;
	createError?: string;
	onConfirm: () => void | Promise<void>;
	onCancel: () => void;
} = $props();

const MIN_PASSWORD_LENGTH = 8;
const GENERATED_LENGTH = 14;
const GENERATED_ALPHABET =
	"abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

let passwordLongEnough = $derived(password.length >= MIN_PASSWORD_LENGTH);

/**
 * Suggests a password so the admin does not have to invent one — the account
 * owner changes it later from their profile. Uses the platform CSPRNG when it
 * is available and falls back to Math.random only in environments without it
 * (jsdom under test).
 */
function generatePassword() {
	const alphabet = GENERATED_ALPHABET;
	const picks = new Array<string>(GENERATED_LENGTH);
	const cryptoApi = globalThis.crypto;
	if (cryptoApi?.getRandomValues) {
		const buffer = new Uint32Array(GENERATED_LENGTH);
		cryptoApi.getRandomValues(buffer);
		for (let index = 0; index < GENERATED_LENGTH; index += 1) {
			picks[index] = alphabet[buffer[index] % alphabet.length];
		}
	} else {
		for (let index = 0; index < GENERATED_LENGTH; index += 1) {
			picks[index] = alphabet[Math.floor(Math.random() * alphabet.length)];
		}
	}
	password = picks.join("");
	showPassword = true;
}
</script>

<DialogShell
	title={$t('admin.createUserTitle')}
	description={$t('admin.createUserDescription')}
	onClose={onCancel}
	maxWidthClass="max-w-[38rem]"
	zIndexClass="z-[9999]"
>
	<div class="max-h-[calc(100vh-2rem)] overflow-y-auto">
		<div class="grid gap-4">
			<div>
				<label class="settings-label" for="create-user-name">{$t('settings_displayName')}</label>
				<input
					id="create-user-name"
					type="text"
					class="settings-input"
					bind:value={name}
					placeholder={$t('admin.optionalDisplayName')}
				/>
			</div>
			<div>
				<label class="settings-label" for="create-user-email">{$t('admin.email')}</label>
				<input
					id="create-user-email"
					type="email"
					class="settings-input"
					bind:value={email}
					placeholder={$t('admin.emailPlaceholder')}
				/>
			</div>
			<div>
				<div class="password-row">
					<div class="min-w-0 flex-1">
						<PasswordField
							id="create-user-password"
							label={$t('admin.password')}
							bind:value={password}
							bind:shown={showPassword}
							autocomplete="new-password"
							placeholder={$t('admin.passwordPlaceholder')}
						/>
					</div>
					<button type="button" class="generate-btn" onclick={generatePassword}>
						{$t('admin.users.generatePassword')}
					</button>
				</div>
				<p class="strength" class:strength-ok={passwordLongEnough}>
					{#if passwordLongEnough}
						<Check size={12} strokeWidth={2.2} aria-hidden="true" />
						{$t('admin.users.passwordLongEnough', { count: password.length })}
					{:else}
						<TriangleAlert size={12} strokeWidth={2.2} aria-hidden="true" />
						{$t('admin.users.passwordTooShort', { count: MIN_PASSWORD_LENGTH })}
					{/if}
				</p>
			</div>
			<div>
				<p class="settings-label">{$t('admin.role')}</p>
				<div class="flex flex-wrap gap-2">
					{#each ['user', 'admin'] as nextRole (nextRole)}
						<button
							type="button"
							class="pref-pill"
							class:pref-pill-active={role === nextRole}
							onclick={() => (role = nextRole as UserRole)}
						>
							{nextRole === 'admin' ? $t('admin.admin') : $t('admin.user')}
						</button>
					{/each}
				</div>
				<p class="role-note">{$t('admin.users.adminGrantsNote')}</p>
			</div>
		</div>

		{#if createError}
			<p class="mt-4 text-sm text-danger" role="alert">{createError}</p>
		{/if}

		<div class="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
			<button type="button" class="btn-secondary w-full sm:w-auto" onclick={onCancel}>{$t('common.cancel')}</button>
			<button
				type="button"
				class="btn-primary w-full whitespace-nowrap sm:w-auto"
				onclick={onConfirm}
				disabled={createLoading || !email.trim() || password.length < MIN_PASSWORD_LENGTH}
			>
				{createLoading ? $t('admin.creating') : $t('admin.createUser')}
			</button>
		</div>
	</div>
</DialogShell>

<style>
	.password-row {
		display: flex;
		align-items: flex-end;
		gap: 0.5rem;
	}

	.generate-btn {
		display: inline-flex;
		align-items: center;
		height: 2.25rem;
		padding: 0 0.6rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border-default);
		background: var(--surface-page);
		color: var(--text-secondary);
		font-size: var(--text-2xs);
		white-space: nowrap;
		cursor: pointer;
		transition:
			border-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	.generate-btn:hover {
		border-color: color-mix(in srgb, var(--accent) 45%, transparent);
		color: var(--accent);
	}

	.generate-btn:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.strength {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		margin-top: 0.35rem;
		font-size: var(--text-2xs);
		color: var(--text-muted);
	}

	.strength-ok {
		color: var(--success);
	}

	.role-note {
		margin-top: 0.4rem;
		font-size: var(--text-2xs);
		line-height: 1.5;
		color: var(--text-muted);
	}
</style>
