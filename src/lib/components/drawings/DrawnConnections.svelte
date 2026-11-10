<script lang="ts">
/**
 * The Connections tab of Settings (`SettingsConnectionsTab.svelte`) in a
 * narrow column: the privacy card with its switch (`PrivacyCard.svelte`, off,
 * as it starts) over the "Add a connection" card (`AddConnectionGrid.svelte`),
 * whose tiles are an icon and two grey lines. The tiles shown are the
 * providers whose real mark is a Lucide icon (`BrandIcon.svelte`'s fallbacks:
 * email, OwnTracks and OneDrive); the others are brand glyphs, which a drawing
 * does not draw.
 */
import { Cloud, Mail, MapPin } from "@lucide/svelte";
import DrawnBar from "./DrawnBar.svelte";
import DrawnSettingsCard from "./DrawnSettingsCard.svelte";
import DrawnSwitch from "./DrawnSwitch.svelte";

const TILES = [Mail, MapPin, Cloud] as const;
</script>

<div class="drawn-connections">
	<DrawnSettingsCard>
		<div class="privacy">
			<DrawnSwitch on={false} />
			<span class="privacy-text">
				<DrawnBar width="88%" />
				<DrawnBar width="66%" tone="soft" />
			</span>
		</div>
	</DrawnSettingsCard>
	<DrawnSettingsCard title="connections.addConnection.title">
		<div class="grid">
			{#each TILES as Tile}
				<span class="tile">
					<span class="mark"><span class="drawn-ic"><Tile size="100%" strokeWidth={2} aria-hidden="true" /></span></span>
					<span class="tile-text">
						<DrawnBar width="90%" />
						<DrawnBar width="72%" tone="soft" />
					</span>
				</span>
			{/each}
		</div>
	</DrawnSettingsCard>
</div>

<style>
	.drawn-connections {
		display: flex;
		flex-direction: column;
		gap: calc(var(--u) * 4);
	}

	.privacy {
		display: flex;
		align-items: center;
		gap: calc(var(--u) * 7);
	}

	.privacy-text {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: calc(var(--u) * 3);
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: calc(var(--u) * 4);
	}

	.tile {
		display: flex;
		align-items: center;
		gap: calc(var(--u) * 4);
		min-width: 0;
		padding: calc(var(--u) * 3);
		border: 1px solid var(--border-default);
		border-radius: calc(var(--u) * 4);
		background: var(--surface-page);
	}

	.mark {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		width: calc(var(--u) * 12);
		height: calc(var(--u) * 12);
		border: 1px solid var(--border-default);
		border-radius: calc(var(--u) * 4);
		background: var(--surface-page);
		color: var(--text-secondary);
	}

	.mark .drawn-ic {
		--ic: 7;
	}

	.tile-text {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: calc(var(--u) * 3);
		min-width: 0;
	}
</style>
