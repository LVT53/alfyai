<script lang="ts">
// Redesign R6 (ADR 0044 Decision 5) — the styled privacy policy, rendered at
// the public /privacy route (src/routes/privacy/+page.svelte), the ONE
// surface for the policy (no in-app modal — the Settings profile row just
// links to /privacy). Content lives in src/lib/i18n/legal.ts (en+hu).
import { t, type I18nKey } from "$lib/i18n";
import { PRIVACY_POLICY_SECTIONS } from "$lib/i18n/legal";
</script>

<div class="privacy-policy">
  <h1 class="privacy-policy-title">{$t('legal.privacy.title')}</h1>
  <p class="privacy-policy-updated">
    {$t('legal.privacy.lastUpdatedLabel')}: {$t('legal.privacy.lastUpdatedDate')}
  </p>
  <p class="privacy-policy-intro">{$t('legal.privacy.intro')}</p>

  {#each PRIVACY_POLICY_SECTIONS as section (section)}
    <section class="privacy-policy-section">
      <h2 class="privacy-policy-section-title">
        {$t(`legal.privacy.section.${section}.title` as I18nKey)}
      </h2>
      <p class="privacy-policy-section-body">
        {$t(`legal.privacy.section.${section}.body` as I18nKey)}
      </p>
    </section>
  {/each}
</div>

<style>
	.privacy-policy {
		display: flex;
		flex-direction: column;
		gap: var(--space-lg);
		max-width: 720px;
	}

	.privacy-policy-title {
		font-size: 1.5rem;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0;
	}

	.privacy-policy-updated {
		font-size: 0.8125rem;
		color: var(--text-muted);
		margin: 0;
	}

	.privacy-policy-intro {
		font-size: 0.9375rem;
		line-height: 1.6;
		color: var(--text-secondary);
		margin: 0;
	}

	.privacy-policy-section {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
	}

	.privacy-policy-section-title {
		font-size: 1rem;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0;
	}

	.privacy-policy-section-body {
		font-size: 0.875rem;
		line-height: 1.65;
		color: var(--text-secondary);
		margin: 0;
		white-space: pre-line;
	}
</style>
