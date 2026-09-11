<script lang="ts">
import { goto, invalidateAll } from "$app/navigation";
import { login } from "$lib/client/api/auth";
import { clearClientAccountState } from "$lib/client/session-boundary";
import { t } from "$lib/i18n";
import { AlertTriangle, Eye, EyeOff } from "@lucide/svelte";
import LogoMark from "$lib/components/chat/LogoMark.svelte";
import Spinner from "$lib/components/ui/Spinner.svelte";

let email = $state("");
let password = $state("");
let error = $state("");
let loading = $state(false);
let hydrated = $state(false);
let showPassword = $state(false);
let rememberMe = $state(false);
let formRef = $state<HTMLFormElement | null>(null);

$effect(() => {
	hydrated = true;
});

async function handleSubmit(event: SubmitEvent) {
	event.preventDefault();

	if (!email.trim() || !password.trim()) {
		error = $t("login.pleaseFillAllFields");
		return;
	}

	error = "";
	loading = true;

	try {
		await login(email, password, rememberMe);
		clearClientAccountState();
		await invalidateAll();
		await goto("/", { invalidateAll: true });
	} catch (err) {
		error = err instanceof Error ? err.message : $t("login.unexpectedError");
	} finally {
		loading = false;
	}
}

function handleFormKeydown(event: KeyboardEvent) {
	if (event.key !== "Enter" || event.shiftKey || loading) return;

	const target = event.target;
	if (target instanceof HTMLButtonElement && target.type === "button") {
		return;
	}

	event.preventDefault();
	formRef?.requestSubmit();
}
</script>

<svelte:head>
  <title>{$t('login.signIn')}</title>
</svelte:head>

<div class="flex min-h-[100svh] w-full items-center justify-center bg-surface-page px-4 py-6 md:px-8 md:py-10">
  <div class="mx-auto w-full max-w-[448px] rounded-lg border border-border bg-surface-elevated p-lg md:p-xl shadow-lg">
    <!-- Consistency pass: the first screen of the product was the only one
         that did not look like the product. It carries the wordmark now, and
         the heading joins the 1.75rem / 1.5rem Libre Baskerville ramp instead
         of jumping a size at the md breakpoint. -->
    <div class="mb-5 flex items-center justify-center gap-2" data-testid="login-wordmark">
      <LogoMark size={22} />
      <span class="login-wordmark">AlfyAI</span>
    </div>

    <div class="mb-6 text-center md:mb-8">
      <h1 class="login-title">{$t('login.signIn')}</h1>
      <p class="text-sm text-text-muted">{$t('login.welcomeBack')}</p>
    </div>

    <form bind:this={formRef} method="post" action="/api/auth/login" onsubmit={handleSubmit} class="flex flex-col">
      <div class="flex flex-col gap-md">
        <div class="space-y-2">
          <label for="email" class="block text-sm font-medium text-text-primary">
            {$t('login.emailAddress')}
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autocomplete="email"
            bind:value={email}
            disabled={loading}
            oninput={() => error = ''}
            onkeydown={handleFormKeydown}
            class="box-border block w-full min-h-[44px] rounded-md border border-border bg-surface-page px-md py-sm font-serif text-base text-text-primary shadow-sm transition-shadow focus:border-focus-ring focus:bg-surface-overlay focus:outline-none focus:ring-2 focus:ring-focus-ring disabled:opacity-50"
            placeholder="you@example.com"
          />
        </div>

        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <label for="password" class="block text-sm font-medium text-text-primary">
              {$t('login.password')}
            </label>
            <button
              type="button"
              class="flex items-center gap-1 text-xs text-text-muted hover:text-text-primary transition-colors"
              onclick={() => showPassword = !showPassword}
              tabindex="-1"
              aria-label={showPassword ? $t('login.hidePassword') : $t('login.showPassword')}
            >
              {#if showPassword}
                <EyeOff size={14} strokeWidth={2} aria-hidden="true" />
              {:else}
                <Eye size={14} strokeWidth={2} aria-hidden="true" />
              {/if}
            </button>
          </div>
          <input
            id="password"
            name="password"
            type={showPassword ? 'text' : 'password'}
            autocomplete="current-password"
            bind:value={password}
            disabled={loading}
            oninput={() => error = ''}
            onkeydown={handleFormKeydown}
            class="box-border block w-full min-h-[44px] rounded-md border border-border bg-surface-page px-md py-sm font-serif text-base text-text-primary shadow-sm transition-shadow focus:border-focus-ring focus:bg-surface-overlay focus:outline-none focus:ring-2 focus:ring-focus-ring disabled:opacity-50"
            placeholder="••••••••"
          />
        </div>
      </div>

      <label class="mt-md flex min-h-[32px] items-center gap-sm text-sm text-text-primary">
        <input
          name="rememberMe"
          type="checkbox"
          value="true"
          bind:checked={rememberMe}
          disabled={loading}
          class="h-4 w-4 rounded border-border bg-surface-page text-accent focus:ring-2 focus:ring-focus-ring disabled:opacity-50"
        />
        <span>{$t('login.rememberMe')}</span>
      </label>

      <!-- The error sits directly above the button you are about to press
           again, not between the fields and the checkbox. -->
      {#if error}
        <p class="login-error" role="alert" data-testid="login-error">
          <AlertTriangle size={13} strokeWidth={2} aria-hidden="true" />
          <span>{error}</span>
        </p>
      {/if}

      <button
        type="submit"
        disabled={loading || !hydrated}
		class="btn-primary btn-lg mt-lg flex w-full cursor-pointer items-center justify-center disabled:cursor-not-allowed disabled:opacity-70"
      >
        {#if loading}
          <Spinner class="-ml-1 mr-2" size={16} />
          {$t('login.signingIn')}
        {:else}
          {$t('login.signIn')}
        {/if}
      </button>
    </form>
  </div>
</div>

<style>
	/* One title ramp across the product: Libre Baskerville at −0.02em. */
	.login-title {
		margin: 0 0 0.5rem 0;
		font-family: var(--font-serif);
		font-size: 1.5rem;
		font-weight: 500;
		letter-spacing: -0.02em;
		color: var(--text-primary);
	}

	.login-wordmark {
		font-family: var(--font-sans);
		font-size: 1.25rem;
		font-weight: 600;
		letter-spacing: -0.03em;
		color: var(--text-primary);
		opacity: 0.9;
	}

	/* The rejected state: a tinted line, not a bare red sentence, so it
	   reads as part of the card in both themes. */
	.login-error {
		display: flex;
		align-items: flex-start;
		gap: 0.4375rem;
		margin: var(--space-md) 0 0 0;
		padding: 0.5rem 0.625rem;
		border: 1px solid color-mix(in srgb, var(--danger) 34%, transparent);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--danger) 7%, var(--surface-page));
		font-size: 0.8125rem;
		line-height: 1.45;
		color: var(--danger);
	}

	.login-error :global(svg) {
		flex-shrink: 0;
		margin-top: 0.125rem;
	}
</style>
