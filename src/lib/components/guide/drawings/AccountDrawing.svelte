<script lang="ts">
/**
 * The Your account section's drawing: a slice of Settings > Profile, in its
 * two columns. At the left, the account card's two-step row (under a rule and
 * the password's box) and the Your Activity card; at the right, the
 * Preferences card's Appearance and Interface language and the Data & privacy
 * card's Import and Download rows.
 *
 * The spot ids are the guide's `drawingSpot`s for this section
 * (`section-drawing-spots.ts`): `twoStep` is the row, `activity` and `data`
 * their whole cards, and `language` the two rows of the look and the language
 * (the row of the guide is about both).
 */
import { ShieldCheck } from "@lucide/svelte";
import DrawingFrame from "$lib/components/drawings/DrawingFrame.svelte";
import DrawnBar from "$lib/components/drawings/DrawnBar.svelte";
import DrawnButton from "$lib/components/drawings/DrawnButton.svelte";
import DrawnSegmented from "$lib/components/drawings/DrawnSegmented.svelte";
import DrawnSettingsCard from "$lib/components/drawings/DrawnSettingsCard.svelte";
import DrawnSettingsRow from "$lib/components/drawings/DrawnSettingsRow.svelte";
import DrawnSpot from "$lib/components/drawings/DrawnSpot.svelte";
import { t } from "$lib/i18n";

let { lit = null }: { lit?: string | null } = $props();
</script>

<DrawingFrame>
	<div class="page">
		<div class="column">
			<DrawnSettingsCard>
				<span class="field"><DrawnBar width="50%" tone="soft" /></span>
				<div class="rule"></div>
				<DrawnSpot spot="twoStep" {lit} bleed={4}>
					<DrawnSettingsRow label="profileTab.twoStepTitle" help={['92%', '66%']} stacked>
						<DrawnButton variant="secondary" word="profileTab.twoStepTurnOn" icon={ShieldCheck} />
					</DrawnSettingsRow>
				</DrawnSpot>
			</DrawnSettingsCard>
			<DrawnSpot spot="activity" {lit}>
				<DrawnSettingsCard title="settings_sectionYourActivity">
					<div class="hero">
						<span class="value"><DrawnBar width="34%" tone="accent" thick /></span>
						<span class="hero-label">{$t('profileTab.tokensAllTime')}</span>
						<span class="split"><i></i><i class="soft"></i></span>
					</div>
					<div class="stats">
						<span class="stat"><DrawnBar width="40%" thick /><DrawnBar width="76%" tone="soft" /></span>
						<span class="stat"><DrawnBar width="34%" thick /><DrawnBar width="82%" tone="soft" /></span>
					</div>
				</DrawnSettingsCard>
			</DrawnSpot>
		</div>
		<div class="column">
			<DrawnSettingsCard>
				<DrawnSpot spot="language" {lit} bleed={4}>
					<DrawnSettingsRow label="settings_appearance" stacked>
						<DrawnSegmented options={['settings_system', 'settings_light', 'settings_dark']} />
					</DrawnSettingsRow>
					<DrawnSettingsRow label="settings_interfaceLanguage" stacked divider>
						<DrawnSegmented options={['profileTab.langEnglish', 'profileTab.langHungarian']} />
					</DrawnSettingsRow>
				</DrawnSpot>
			</DrawnSettingsCard>
			<DrawnSpot spot="data" {lit}>
				<DrawnSettingsCard title="settings_sectionDataPrivacy">
					<DrawnSettingsRow label="chatgptImport.settingsButton" stacked>
						<DrawnButton variant="secondary" word="profileTab.importChooseZip" />
					</DrawnSettingsRow>
					<DrawnSettingsRow label="settings_downloadMyData" stacked divider>
						<DrawnButton variant="secondary" word="profileTab.prepareArchive" />
					</DrawnSettingsRow>
				</DrawnSettingsCard>
			</DrawnSpot>
		</div>
	</div>
</DrawingFrame>

<style>
	.page {
		position: absolute;
		inset: 0;
		display: flex;
		gap: calc(var(--u) * 8);
		box-sizing: border-box;
		padding: calc(var(--u) * 10) calc(var(--u) * 10) 0;
		background: var(--surface-page);
	}

	.column {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: calc(var(--u) * 6);
		min-width: 0;
	}

	/* The password's box above the rule that opens the two-step row. */
	.field {
		display: flex;
		align-items: center;
		height: calc(var(--u) * 13);
		padding: 0 calc(var(--u) * 6);
		border: 1px solid var(--border-default);
		border-radius: calc(var(--u) * 4);
		background: var(--surface-page);
	}

	.rule {
		height: 1px;
		margin: calc(var(--u) * 6) 0 calc(var(--u) * 2);
		background: var(--border-default);
	}

	/* The hero of Your Activity: its figure, what it counts and how it splits. */
	.hero {
		display: flex;
		flex-direction: column;
		gap: calc(var(--u) * 4);
		padding: calc(var(--u) * 6);
		border: 1px solid var(--accent);
		border-radius: calc(var(--u) * 4);
		background: var(--surface-page);
	}

	.value {
		display: flex;
	}

	.hero-label {
		color: var(--text-muted);
		font-size: calc(var(--u) * 7);
		white-space: nowrap;
	}

	.split {
		display: flex;
		gap: calc(var(--u) * 1);
		height: calc(var(--u) * 3);
		border-radius: calc(var(--u) * 3);
		overflow: hidden;
	}

	.split i {
		flex: 3;
		background: var(--accent);
	}

	.split i.soft {
		flex: 1;
		background: color-mix(in srgb, var(--accent) 40%, transparent);
	}

	.stats {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: calc(var(--u) * 5);
		margin-top: calc(var(--u) * 5);
	}

	.stat {
		display: flex;
		flex-direction: column;
		gap: calc(var(--u) * 4);
		padding: calc(var(--u) * 5) calc(var(--u) * 6);
		border: 1px solid var(--border-default);
		border-radius: calc(var(--u) * 4);
		background: var(--surface-page);
	}
</style>
