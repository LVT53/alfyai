<script lang="ts">
import { t } from "$lib/i18n";
import type { EvidencePreference, TaskSteeringPayload } from "$lib/types";

let {
	artifactId,
	preference = "auto",
	label = undefined,
	onSteer,
}: {
	artifactId: string;
	preference?: EvidencePreference;
	label?: string | undefined;
	onSteer?: (payload: TaskSteeringPayload) => void;
} = $props();

let resolvedLabel = $derived(label ?? $t("contextSources.sourcePreference"));

function handleChange(event: Event) {
	const nextPreference = (event.currentTarget as HTMLSelectElement)
		.value as EvidencePreference;
	onSteer?.({
		action: "set_artifact_preference",
		artifactId,
		preference: nextPreference,
	});
}
</script>

<label class="preference-shell">
	<span class="sr-only">{resolvedLabel}</span>
	<select class="preference-select" value={preference} aria-label={resolvedLabel} onchange={handleChange}>
		<option value="auto">{$t('contextSources.preference.auto')}</option>
		<option value="pinned">{$t('contextSources.preference.pinned')}</option>
		<option value="excluded">{$t('contextSources.preference.excluded')}</option>
	</select>
</label>

<style>
	.preference-shell {
		position: relative;
		display: inline-flex;
		align-items: center;
	}

	.preference-select {
		border: 1px solid color-mix(in srgb, var(--border-default) 72%, transparent 28%);
		border-radius: 9999px;
		background: color-mix(in srgb, var(--surface-page) 78%, var(--surface-elevated) 22%);
		padding: 0.28rem 1.8rem 0.28rem 0.62rem;
		font-size: 0.68rem;
		font-family: 'Nimbus Sans L', sans-serif;
		color: var(--text-primary);
		appearance: none;
		background-image:
			linear-gradient(45deg, transparent 50%, currentColor 50%),
			linear-gradient(135deg, currentColor 50%, transparent 50%);
		background-position:
			calc(100% - 0.85rem) calc(50% - 0.08rem),
			calc(100% - 0.55rem) calc(50% - 0.08rem);
		background-size: 0.32rem 0.32rem, 0.32rem 0.32rem;
		background-repeat: no-repeat;
	}

	.preference-select:focus-visible {
		outline: none;
		border-color: color-mix(in srgb, var(--accent) 40%, var(--border-default) 60%);
	}
</style>
