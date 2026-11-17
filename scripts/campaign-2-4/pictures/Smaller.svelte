<script lang="ts">
/**
 * Card 6, smaller changes: the Preferences card of Settings with its new Time
 * zone row ringed, under Appearance and the interface language. The rows are
 * the kit's Settings parts, so their words are the real rows' keys.
 */
import DrawingFrame from "$lib/components/drawings/DrawingFrame.svelte";
import DrawnSegmented from "$lib/components/drawings/DrawnSegmented.svelte";
import DrawnSelect from "$lib/components/drawings/DrawnSelect.svelte";
import DrawnSettingsCard from "$lib/components/drawings/DrawnSettingsCard.svelte";
import DrawnSettingsRow from "$lib/components/drawings/DrawnSettingsRow.svelte";
import DrawnSpot from "$lib/components/drawings/DrawnSpot.svelte";
import { DESIGN_SIZE, type Variant } from "../sizes";

let { variant }: { variant: Variant } = $props();

let phone = $derived(variant === "mobile");
</script>

<DrawingFrame width={DESIGN_SIZE[variant].width} height={DESIGN_SIZE[variant].height} bare>
	<div class="page" class:phone>
		<div class="card">
			<DrawnSettingsCard title="settings_sectionPreferences">
				<DrawnSettingsRow label="settings_appearance" stacked>
					<DrawnSegmented options={['settings_system', 'settings_light', 'settings_dark']} active={1} />
				</DrawnSettingsRow>
				<DrawnSettingsRow label="settings_interfaceLanguage" stacked divider>
					<DrawnSegmented options={['profileTab.langEnglish', 'profileTab.langHungarian']} active={1} />
				</DrawnSettingsRow>
				<DrawnSpot spot="timeZone" lit="timeZone" bleed={4}>
					<DrawnSettingsRow label="profileTab.timeZone" help={['88%']} stacked divider>
						<span class="select"><DrawnSelect /></span>
					</DrawnSettingsRow>
				</DrawnSpot>
			</DrawnSettingsCard>
		</div>
	</div>
</DrawingFrame>

<style>
	.page {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--surface-page);
	}

	.card {
		width: calc(var(--u) * 196);
		font-size: calc(var(--u) * 10);
	}

	.select {
		display: block;
		width: calc(var(--u) * 120);
	}

	.phone .card {
		width: calc(var(--u) * 176);
	}
</style>
