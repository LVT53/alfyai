<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { login } from '$lib/client/api/auth';
  import { clearClientAccountState } from '$lib/client/session-boundary';
  import { t } from '$lib/i18n';

  let email = $state('');
  let password = $state('');
  let error = $state('');
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
      error = $t('login.pleaseFillAllFields');
      return;
    }

    error = '';
    loading = true;

    try {
      await login(email, password, rememberMe);
      clearClientAccountState();
      await invalidateAll();
      await goto('/', { invalidateAll: true });
    } catch (err) {
      error = err instanceof Error
        ? err.message
        : $t('login.unexpectedError');
    } finally {
      loading = false;
    }
  }

  function handleFormKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' || event.shiftKey || loading) return;

    const target = event.target;
    if (target instanceof HTMLButtonElement && target.type === 'button') {
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
    <div class="mb-6 text-center md:mb-8">
      <h1 class="mb-2 text-2xl font-serif font-medium text-text-primary md:text-3xl">{$t('login.signIn')}</h1>
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
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                  <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                  <line x1="1" y1="1" x2="23" y2="23"/>
                </svg>
              {:else}
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                  <circle cx="12" cy="12" r="3"/>
                </svg>
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

      {#if error}
        <p class="mt-md text-sm text-danger" role="alert" data-testid="login-error">{error}</p>
      {/if}

      <button
        type="submit"
        disabled={loading || !hydrated}
        class="btn-primary mt-lg flex min-h-[44px] w-full cursor-pointer items-center justify-center disabled:cursor-not-allowed disabled:opacity-70"
      >
        {#if loading}
          <svg class="animate-spin -ml-1 mr-2 h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          {$t('login.signingIn')}
        {:else}
          {$t('login.signIn')}
        {/if}
      </button>
    </form>
  </div>
</div>
