<script lang="ts">
// Redesign R6 (ADR 0044 Decision 5) — the public, unauthenticated /privacy
// route. This exists so AlfyAI's Google OAuth verification (and anyone else)
// can reach the privacy policy without signing in. It is allowlisted in
// PUBLIC_PATHS in src/hooks.server.ts, outside the (app) route group's auth
// guard (see src/routes/(app)/+layout.server.ts).
//
// This is the ONE surface for the policy (ADR 0044 Decision 5 — an earlier
// build also added an in-app full-screen modal; the product owner asked to
// remove it, so the Settings profile row just links here instead of
// duplicating the content in a second renderer).
import LogoMark from "$lib/components/chat/LogoMark.svelte";
import PrivacyPolicy from "$lib/components/legal/PrivacyPolicy.svelte";
import { t } from "$lib/i18n";
</script>

<svelte:head>
  <title>{$t('legal.privacy.title')} — AlfyAI</title>
</svelte:head>

<div class="privacy-page">
  <header class="privacy-page-header">
    <LogoMark size={28} />
    <span class="privacy-page-brand">AlfyAI</span>
  </header>

  <main class="privacy-page-main">
    <PrivacyPolicy />
  </main>

  <footer class="privacy-page-footer">
    <a class="privacy-page-home-link" href="/">AlfyAI</a>
  </footer>
</div>

<style>
	.privacy-page {
		display: flex;
		flex-direction: column;
		/* The global app shell locks `body { overflow: hidden }` (app.css) and
		   scrolls its own inner container, so this public route — which lives on
		   that same locked body — must be its OWN scroll container, or the policy
		   is unscrollable below the fold. Fixed viewport height + overflow-y auto. */
		height: 100svh;
		overflow-y: auto;
		background: var(--surface-page);
	}

	.privacy-page-header {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		padding: var(--space-lg) var(--space-lg) var(--space-md);
		border-bottom: 1px solid var(--border-default);
	}

	.privacy-page-brand {
		font-size: 1.0625rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.privacy-page-main {
		flex: 1;
		width: 100%;
		max-width: 760px;
		margin: 0 auto;
		padding: var(--space-xl) var(--space-lg) var(--space-2xl);
		box-sizing: border-box;
	}

	.privacy-page-footer {
		padding: var(--space-md) var(--space-lg);
		border-top: 1px solid var(--border-default);
		text-align: center;
	}

	.privacy-page-home-link {
		font-size: 0.8125rem;
		color: var(--text-muted);
		text-decoration: none;
	}

	.privacy-page-home-link:hover {
		color: var(--accent);
		text-decoration: underline;
	}
</style>
