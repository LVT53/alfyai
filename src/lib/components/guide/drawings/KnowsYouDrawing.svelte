<script lang="ts">
/**
 * The It knows you section's drawing: the Knowledge Base's Memory Profile
 * beside a slice of Settings > Profile. The Memory Profile is its portrait
 * card and the Needs Review card; the slice is the Preferences card's Default
 * model and Conversation style and the Assistant behaviour card's Personal
 * instructions, Memory switch and Skills, in the order Settings draws them.
 *
 * The spot ids are the guide's `drawingSpot`s for this section
 * (`section-drawing-spots.ts`): `memory` is the portrait card and the Memory
 * switch (the row is about seeing what Alfy remembers and about switching it
 * off, so it rings both), `style` the two rows of the model and the style (one
 * row of the guide is about both), `instructions` and `skills` their rows. Show
 * me rings the Memory Profile's tab; the drawing lights the card the tab opens.
 */
import { Pencil } from "@lucide/svelte";
import DrawingFrame from "$lib/components/drawings/DrawingFrame.svelte";
import DrawnBar from "$lib/components/drawings/DrawnBar.svelte";
import DrawnButton from "$lib/components/drawings/DrawnButton.svelte";
import DrawnMemoryProfile from "$lib/components/drawings/DrawnMemoryProfile.svelte";
import DrawnSelect from "$lib/components/drawings/DrawnSelect.svelte";
import DrawnSettingsCard from "$lib/components/drawings/DrawnSettingsCard.svelte";
import DrawnSettingsRow from "$lib/components/drawings/DrawnSettingsRow.svelte";
import DrawnSpot from "$lib/components/drawings/DrawnSpot.svelte";
import DrawnSwitch from "$lib/components/drawings/DrawnSwitch.svelte";
import DrawnSwitcher from "$lib/components/drawings/DrawnSwitcher.svelte";
import { t } from "$lib/i18n";

let { lit = null }: { lit?: string | null } = $props();
</script>

<DrawingFrame>
	<div class="knowledge">
		<DrawnSwitcher items={[{ word: 'memory.title', badge: true }, { word: 'knowledge.documents' }]} />
		<DrawnMemoryProfile {lit} spot="memory" />
	</div>
	<div class="settings">
		<DrawnSettingsCard>
			<DrawnSpot spot="style" {lit} bleed={4}>
				<DrawnSettingsRow label="settings_defaultModel" stacked>
					<DrawnSelect />
				</DrawnSettingsRow>
				<DrawnSettingsRow label="settings_conversationStyle" stacked divider>
					<DrawnSelect />
				</DrawnSettingsRow>
			</DrawnSpot>
		</DrawnSettingsCard>
		<DrawnSettingsCard>
			<DrawnSpot spot="instructions" {lit} bleed={4}>
				<DrawnSettingsRow label="profileTab.personalInstructions" help={['86%']} stacked>
					<div class="instructions">
						<span class="preview"><DrawnBar width="54%" tone="soft" /></span>
						<DrawnButton word="profileTab.personalInstructionsEdit" icon={Pencil} />
					</div>
				</DrawnSettingsRow>
			</DrawnSpot>
			<DrawnSpot spot="memory" {lit} bleed={4}>
				<DrawnSettingsRow label="settings_memory" divider>
					<DrawnSwitch />
					<span class="state">{$t('profileTab.memoryOn')}</span>
				</DrawnSettingsRow>
			</DrawnSpot>
			<DrawnSpot spot="skills" {lit} bleed={4}>
				<DrawnSettingsRow label="settings_skillsManagerSummaryLabel" stacked divider>
					<DrawnButton word="profileTab.manageSkills" chevron />
				</DrawnSettingsRow>
			</DrawnSpot>
		</DrawnSettingsCard>
	</div>
</DrawingFrame>

<style>
	/* Two pages side by side, as the Make drawing sets its chat beside its panel. */
	.knowledge,
	.settings {
		position: absolute;
		top: 0;
		bottom: 0;
		display: flex;
		flex-direction: column;
		gap: calc(var(--u) * 5);
		box-sizing: border-box;
		padding: calc(var(--u) * 10) calc(var(--u) * 9);
		background: var(--surface-page);
	}

	.knowledge {
		left: 0;
		width: 50%;
		border-right: 1px solid var(--border-default);
	}

	.settings {
		right: 0;
		left: 50%;
	}

	.instructions {
		display: flex;
		align-items: center;
		gap: calc(var(--u) * 4);
	}

	/* What is saved, shown on one line: a box with its start in it. */
	.preview {
		display: flex;
		flex: 1;
		align-items: center;
		min-width: 0;
		height: calc(var(--u) * 14);
		padding: 0 calc(var(--u) * 5);
		border: 1px solid var(--border-subtle);
		border-radius: calc(var(--u) * 4);
		background: var(--surface-page);
	}

	.state {
		color: var(--text-muted);
		font-size: calc(var(--u) * 7.5);
	}
</style>
