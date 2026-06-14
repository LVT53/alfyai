<script lang="ts">
import { t } from "$lib/i18n";

let {
	compactVersion,
	fullVersion,
	onClick,
}: {
	compactVersion: string;
	fullVersion: string;
	onClick?: () => void;
} = $props();
</script>

<button
	type="button"
	class="app-version-badge cursor-pointer rounded border border-border px-1.5 py-0.5 text-[11px] font-medium leading-none text-text-muted transition-colors duration-150 hover:border-border-focus hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
	aria-label={$t("appVersion.label", { version: compactVersion })}
	title={$t("appVersion.title", { version: fullVersion })}
	onclick={() => onClick?.()}
>
	{compactVersion}
</button>
