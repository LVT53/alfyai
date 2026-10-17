<script lang="ts">
import { goto, invalidateAll } from "$app/navigation";
import { page } from "$app/state";
import { login, verifyTwoStepSignIn } from "$lib/client/api/auth";
import { ApiError } from "$lib/client/api/http";
import { clearClientAccountState } from "$lib/client/session-boundary";
import { type I18nKey, t } from "$lib/i18n";
import {
	AlertTriangle,
	ArrowLeft,
	Eye,
	EyeOff,
	KeyRound,
} from "@lucide/svelte";
import LogoMark from "$lib/components/chat/LogoMark.svelte";
import Spinner from "$lib/components/ui/Spinner.svelte";
import { tick } from "svelte";

/**
 * Server error keys this page is willing to localize. An allowlist rather than
 * a passthrough, so a response body can never select an arbitrary dictionary
 * entry to display on the unauthenticated login screen.
 */
const LOCALIZED_LOGIN_ERROR_KEYS: readonly string[] = [
	"login.tooManyAttempts",
	"login.twoStepWrongCode",
	"login.twoStepTooManyTries",
	"login.twoStepExpired",
	"login.twoStepRestart",
	"login.twoStepUnavailable",
	"login.twoStepTooManyAttempts",
];

/** Where the second step's refusals send the person back to the password step. */
const RESTART_KEYS: readonly string[] = [
	"login.twoStepTooManyTries",
	"login.twoStepExpired",
	"login.twoStepRestart",
];

let email = $state("");
let password = $state("");
let error = $state("");
let loading = $state(false);
let hydrated = $state(false);
let showPassword = $state(false);
let rememberMe = $state(false);
let formRef = $state<HTMLFormElement | null>(null);

/**
 * The card's two steps. `?step=two-step` is what a native form post lands on
 * when the account has a factor (the password step's redirect), so the first
 * hydrated frame is already asking for the code (R15).
 */
type Step = "password" | "code" | "backup";
let step = $state<Step>(
	page.url.searchParams.get("step") === "two-step" ? "code" : "password",
);
let code = $state("");
let backupCode = $state("");
let codeError = $state("");
/** A restart's sentence, shown back on the password step. */
let stepNotice = $state("");
let verifying = $state(false);
/** The code the automatic submit already sent, so it never fires twice. */
let autoSubmittedCode = $state("");
let codeInput = $state<HTMLInputElement | null>(null);

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

// The code step is the only field on the card; put the caret in it as soon as
// it appears (a query-param step included).
$effect(() => {
	if (step === "password") return;
	void tick().then(() => codeInput?.focus());
});

async function finish(twoStepBackupLeft?: number) {
	clearClientAccountState();
	await invalidateAll();
	await goto(
		twoStepBackupLeft === undefined
			? "/"
			: `/?twoStepBackupLeft=${twoStepBackupLeft}`,
		{ invalidateAll: true },
	);
}

async function handleSubmit(event: SubmitEvent) {
	event.preventDefault();

	if (!email.trim() || !password.trim()) {
		error = $t("login.pleaseFillAllFields");
		return;
	}

	error = "";
	loading = true;

	try {
		const result = await login(email, password, rememberMe);
		if (result.twoStep) {
			step = "code";
			error = "";
			return;
		}
		await finish();
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
	if (event.key !== "Enter" || event.shiftKey || loading || verifying) return;

	const target = event.target;
	if (target instanceof HTMLButtonElement && target.type === "button") {
		return;
	}

	event.preventDefault();
	formRef?.requestSubmit();
}

function handleCodeInput(event: Event) {
	const target = event.currentTarget as HTMLInputElement;
	// One input, digits only: password managers and a phone's code autofill
	// both work because it stays a single text field (spec §3.1).
	const digits = target.value.replace(/\D/g, "").slice(0, 6);
	code = digits;
	target.value = digits;
	codeError = "";
	if (digits.length < 6) autoSubmittedCode = "";
	if (digits.length === 6 && autoSubmittedCode !== digits) {
		autoSubmittedCode = digits;
		void verifySecondStep();
	}
}

function switchToBackup() {
	step = "backup";
	codeError = "";
	backupCode = "";
	autoSubmittedCode = "";
}

function switchToApp() {
	step = "code";
	codeError = "";
	code = "";
	autoSubmittedCode = "";
}

function backToPassword() {
	step = "password";
	code = "";
	backupCode = "";
	codeError = "";
	stepNotice = "";
	autoSubmittedCode = "";
}

/**
 * The code step's one request. A wrong code keeps the card and names the tries
 * left; a restart (too many tries, expired, no attempt) puts the password step
 * back with the server's sentence; an unreadable factor asks for the admin.
 */
async function verifySecondStep(event?: SubmitEvent) {
	event?.preventDefault();
	if (verifying) return;

	const input = step === "backup" ? { backupCode } : { code };
	if (step === "backup" && !backupCode.trim()) {
		codeError = $t("login.twoStepBackupRequired");
		return;
	}
	if (step === "code" && !/^\d{6}$/.test(code)) {
		codeError = $t("login.twoStepCodeRequired");
		return;
	}

	verifying = true;
	codeError = "";
	try {
		const result = await verifyTwoStepSignIn(input);
		await finish(result.usedBackupCode ? result.backupCodesLeft : undefined);
	} catch (err) {
		const errorKey =
			err instanceof ApiError && err.errorKey ? err.errorKey : null;
		const details = err instanceof ApiError ? (err.details ?? {}) : {};
		const triesLeft =
			typeof details.triesLeft === "number" ? details.triesLeft : null;

		if (errorKey === "login.twoStepWrongCode" && triesLeft !== null) {
			codeError = $t("login.twoStepWrongCode", { count: triesLeft });
			return;
		}
		if (errorKey && RESTART_KEYS.includes(errorKey)) {
			step = "password";
			code = "";
			backupCode = "";
			autoSubmittedCode = "";
			stepNotice = $t(errorKey as I18nKey);
			return;
		}
		if (errorKey && LOCALIZED_LOGIN_ERROR_KEYS.includes(errorKey)) {
			codeError = $t(errorKey as I18nKey);
			return;
		}
		codeError =
			err instanceof Error ? err.message : $t("login.unexpectedError");
	} finally {
		verifying = false;
	}
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

    <div class="mb-6 text-center md:mb-8" data-testid="login-heading">
      <h1 class="login-title">
        {#if step === 'password'}
          {$t('login.signIn')}
        {:else if step === 'backup'}
          {$t('login.twoStepBackupTitle')}
        {:else}
          {$t('login.twoStepTitle')}
        {/if}
      </h1>
      {#if step === 'password'}
        <p class="text-sm text-text-muted">{$t('login.welcomeBack')}</p>
      {:else}
        <p class="login-step-line">
          {step === 'backup' ? $t('login.twoStepBackupLine') : $t('login.twoStepLine')}
        </p>
      {/if}
    </div>

    {#if step === 'password'}
      {#if sessionExpired && !error}
        <p class="login-session-expired" role="status" data-testid="login-session-expired">
          <AlertTriangle size={13} strokeWidth={2} aria-hidden="true" />
          <span>{$t('sessionExpired.loginNotice')}</span>
        </p>
      {/if}

      {#if stepNotice}
        <p class="login-session-expired" role="status" data-testid="login-two-step-notice">
          <AlertTriangle size={13} strokeWidth={2} aria-hidden="true" />
          <span>{stepNotice}</span>
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
    {:else}
      <!-- The same card, changed in place. One input, so a password manager
           or a phone's one-time-code autofill can fill it; the sixth digit
           submits by itself, and Verify submits too. -->
      <form class="flex flex-col" onsubmit={verifySecondStep}>
        <div class="space-y-2">
          <label
            for={step === 'backup' ? 'backup-code' : 'two-step-code'}
            class="block text-sm font-medium text-text-primary"
          >
            {step === 'backup' ? $t('login.twoStepBackupLabel') : $t('login.twoStepCodeLabel')}
          </label>

          {#if step === 'backup'}
            <input
              id="backup-code"
              name="backupCode"
              type="text"
              autocomplete="off"
              spellcheck="false"
              autocapitalize="characters"
              bind:this={codeInput}
              value={backupCode}
              oninput={(event) => {
                backupCode = (event.currentTarget as HTMLInputElement).value;
                codeError = '';
              }}
              onkeydown={handleFormKeydown}
              disabled={verifying}
              class="login-code-input"
              placeholder="XXXXX-XXXXX"
            />
          {:else}
            <input
              id="two-step-code"
              name="code"
              type="text"
              autocomplete="one-time-code"
              inputmode="numeric"
              pattern="[0-9]*"
              maxlength="6"
              spellcheck="false"
              bind:this={codeInput}
              value={code}
              oninput={handleCodeInput}
              onkeydown={handleFormKeydown}
              disabled={verifying}
              class="login-code-input login-code-input--digits"
              placeholder="000000"
            />
          {/if}
        </div>

        {#if codeError}
          <p class="login-error" role="alert" data-testid="login-code-error">
            <AlertTriangle size={13} strokeWidth={2} aria-hidden="true" />
            <span>{codeError}</span>
          </p>
        {/if}

        <button
          type="submit"
          disabled={verifying || (step === 'code' ? code.length !== 6 : !backupCode.trim())}
          class="btn-primary btn-lg mt-lg flex w-full cursor-pointer items-center justify-center disabled:cursor-not-allowed disabled:opacity-70"
          data-testid="login-verify"
        >
          {#if verifying}
            <Spinner class="-ml-1 mr-2" size={16} />
            {$t('login.twoStepVerifying')}
          {:else}
            {$t('login.twoStepVerify')}
          {/if}
        </button>

        <div class="mt-lg flex flex-col items-center gap-2">
          {#if step === 'backup'}
            <button type="button" class="login-link" onclick={switchToApp}>
              <KeyRound size={13} strokeWidth={2} aria-hidden="true" />
              {$t('login.twoStepUseApp')}
            </button>
          {:else}
            <button type="button" class="login-link" onclick={switchToBackup}>
              <KeyRound size={13} strokeWidth={2} aria-hidden="true" />
              {$t('login.twoStepUseBackup')}
            </button>
          {/if}
          <button type="button" class="login-link" onclick={backToPassword}>
            <ArrowLeft size={13} strokeWidth={2} aria-hidden="true" />
            {$t('login.twoStepBack')}
          </button>
        </div>
      </form>
    {/if}
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

	/* The second step's line: the mockup's two centred lines, kept as one
	   sentence at the card's width so it still reads on a phone. */
	.login-step-line {
		margin: 0;
		font-size: 0.8125rem;
		line-height: 1.55;
		color: var(--text-muted);
	}

	/* One field for six digits (never six boxes): a password manager and a
	   phone's autofill both fill one input. More space below the card's
	   elements than the first mockup had, per the owner's note. */
	.login-code-input {
		box-sizing: border-box;
		display: block;
		width: 100%;
		min-height: 48px;
		margin-top: 0.5rem;
		padding: 0.65rem 0.9rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-page);
		font-family: var(--font-mono, Menlo, monospace);
		font-size: 1.05rem;
		letter-spacing: 0.12em;
		color: var(--text-primary);
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
		transition: border-color var(--duration-standard) var(--ease-out), box-shadow var(--duration-standard) var(--ease-out);
	}

	.login-code-input:focus {
		outline: none;
		border-color: var(--focus-ring);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 35%, transparent);
	}

	.login-code-input::placeholder {
		letter-spacing: 0.18em;
		color: var(--text-faint, var(--text-muted));
		opacity: 0.55;
	}

	.login-code-input--digits {
		text-align: center;
		font-size: 1.35rem;
		letter-spacing: 0.3em;
		padding-left: 0.9em;
	}

	.login-link {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.25rem 0.5rem;
		border: 0;
		background: none;
		font-size: 0.8125rem;
		color: var(--text-muted);
		text-decoration: underline;
		text-decoration-color: var(--border-strong, var(--border-default));
		text-underline-offset: 3px;
		cursor: pointer;
		transition: color var(--duration-standard) var(--ease-out);
	}

	.login-link:hover {
		color: var(--text-primary);
	}

	.login-link:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
		border-radius: var(--radius-sm);
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
