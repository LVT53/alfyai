<script lang="ts">
// E2 — the app-wide SvelteKit error boundary (there was none before this
// slice; an uncaught load/render error fell through to SvelteKit's own
// unstyled default page). Renders status-driven, localized copy only —
// `page.error?.message` is never interpolated into the page: it can carry
// internal framework/provider text that was never meant for a user to read.
import { page } from "$app/state";
import { t } from "$lib/i18n";
import { AlertTriangle } from "@lucide/svelte";

let status = $derived(page.status);
let isNotFound = $derived(status === 404);
let title = $derived(
	isNotFound ? $t("errorPage.notFoundTitle") : $t("errorPage.title"),
);
let message = $derived(
	isNotFound ? $t("errorPage.notFoundMessage") : $t("errorPage.message"),
);
</script>

<svelte:head>
	<title>{title}</title>
</svelte:head>

<div class="flex min-h-[100svh] w-full items-center justify-center bg-surface-page px-4 py-6 md:px-8 md:py-10">
	<div class="mx-auto w-full max-w-[448px] rounded-lg border border-border bg-surface-elevated p-lg md:p-xl text-center shadow-lg">
		<div class="mb-4 flex justify-center text-danger">
			<AlertTriangle size={40} strokeWidth={1.5} aria-hidden="true" />
		</div>
		<h1 class="mb-2 text-xl font-serif font-medium text-text-primary md:text-2xl">
			{title}
		</h1>
		<p class="mb-1 text-sm text-text-muted">{status}</p>
		<p class="mb-6 text-sm text-text-secondary">{message}</p>
		<a
			href="/"
			class="btn-primary btn-lg inline-flex w-full items-center justify-center"
		>
			{$t('errorPage.goHome')}
		</a>
	</div>
</div>
