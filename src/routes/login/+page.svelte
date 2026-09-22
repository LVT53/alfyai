<script lang="ts">
import { goto, invalidateAll } from "$app/navigation";
import { page } from "$app/state";
import { login } from "$lib/client/api/auth";
import { ApiError } from "$lib/client/api/http";
import { clearClientAccountState } from "$lib/client/session-boundary";
import { type I18nKey, t } from "$lib/i18n";
import { AlertTriangle, Eye, EyeOff } from "@lucide/svelte";
import LogoMark from "$lib/components/chat/LogoMark.svelte";
import Spinner from "$lib/components/ui/Spinner.svelte";

/**
 * Server error keys this page is willing to localize. An allowlist rather than
 * a passthrough, so a response body can never select an arbitrary dictionary
 * entry to display on the unauthenticated login screen.
 */
const LOCALIZED_LOGIN_ERROR_KEYS: readonly string[] = ["login.tooManyAttempts"];

let email = $state("");
let password = $state("");
let error = $state("");
let loading = $state(false);
let hydrated = $state(false);
let showPassword = $state(false);
let rememberMe = $state(false);
let formRef = $state<HTMLFormElement | null>(null);

/**
 * The session gate sends a page navigation here with this marker when the
 * browser arrived holding a session cookie the server would not accept — i.e.
 * the user was signed in a moment ago. Without it this screen looks like a
 * plain sign-in prompt and never explains why the app stopped.
 */
const sessionExpired = $derived(
	page.url.searchParams.get("session") === "expired",
);

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
		// The server's own strings are English. When it sends an errorKey we
		// recognise (the 429 throttle), show the localized text instead —
		// the same allowlisted code-to-key mapping the chat page uses, so the
		// server can never make this page render an arbitrary dictionary entry.
		const errorKey =
			err instanceof ApiError && err.errorKey ? err.errorKey : null;
		if (errorKey && LOCALIZED_LOGIN_ERROR_KEYS.includes(errorKey)) {
			error = $t(errorKey as I18nKey);
		} else {
			error = err instanceof Error ? err.message : $t("login.unexpectedError");
		}
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

    {#if sessionExpired && !error}
      <p class="login-session-expired" role="status" data-testid="login-session-expired">
        <AlertTriangle size={13} strokeWidth={2} aria-hidden="true" />
        <span>{$t('sessionExpired.loginNotice')}</span>
      </p>
    {/if}

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

      <!-- The app's own tick box (`.custom-checkbox`, src/app.css) on a real
           checkbox input. The label is the touch target: 44px tall on phones,
           and it centres its text on the box. -->
      <label
        class="mt-md flex min-h-[44px] cursor-pointer items-center gap-sm text-sm text-text-primary md:min-h-[32px]"
        data-testid="login-remember"
      >
        <input
          name="rememberMe"
          type="checkbox"
          value="true"
          bind:checked={rememberMe}
          disabled={loading}
          class="custom-checkbox"
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

	/* Same line, warning tone: the session ending is not a rejected attempt,
	   it is the reason the user is looking at this screen at all. Sits above
	   the form, and steps aside for a real error once one exists. */
	.login-session-expired {
		display: flex;
		align-items: flex-start;
		gap: 0.4375rem;
		margin: 0 0 var(--space-md) 0;
		padding: 0.5rem 0.625rem;
		border: 1px solid color-mix(in srgb, var(--warning) 34%, transparent);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--warning) 8%, var(--surface-page));
		font-size: 0.8125rem;
		line-height: 1.45;
		color: var(--text-secondary);
	}

	.login-session-expired :global(svg) {
		flex-shrink: 0;
		margin-top: 0.125rem;
		color: var(--warning);
	}
</style>
