<script lang="ts">
/**
 * The strip of files a reply found in Nextcloud (`FilesStrip.svelte`): picture
 * tiles (the kit's tinted sky), a document tile with its extension, the count
 * tile over a cover, and the chevron that opens the list.
 */
import { ChevronDown } from "@lucide/svelte";
</script>

<div class="strip">
	<span class="tiles">
		<span class="tile picture"></span>
		<span class="tile picture other"></span>
		<span class="tile document"><span class="extension">PDF</span></span>
		<span class="tile picture count"><span class="more">+3</span></span>
	</span>
	<span class="chevron"><span class="drawn-ic" style:--ic="8"><ChevronDown size="100%" strokeWidth={2} aria-hidden="true" /></span></span>
</div>

<style>
	.strip {
		display: inline-flex;
		align-items: center;
		gap: calc(var(--u) * 5);
	}

	.tiles {
		display: inline-flex;
		gap: calc(var(--u) * 3);
	}

	.tile {
		position: relative;
		display: inline-flex;
		flex: none;
		align-items: flex-end;
		justify-content: flex-start;
		width: calc(var(--u) * 30);
		height: calc(var(--u) * 30);
		overflow: hidden;
		border: 1px solid var(--border-default);
		border-radius: calc(var(--u) * 4);
		box-sizing: border-box;
	}

	.picture {
		background:
			radial-gradient(circle at 70% 30%, var(--surface-page) 0 10%, transparent 11%),
			linear-gradient(160deg, var(--accent-tint-strong), var(--surface-elevated) 72%);
	}

	.picture.other {
		background:
			radial-gradient(ellipse at 30% 110%, color-mix(in srgb, var(--text-primary) 12%, transparent) 0 45%, transparent 46%),
			linear-gradient(200deg, var(--accent-tint), var(--surface-elevated) 80%);
	}

	.document {
		background: var(--surface-page);
	}

	.extension {
		margin: 0 0 calc(var(--u) * 3) calc(var(--u) * 3);
		padding: calc(var(--u) * 0.5) calc(var(--u) * 2.5);
		border-radius: calc(var(--u) * 2);
		background: var(--surface-elevated);
		color: var(--text-secondary);
		font-size: calc(var(--u) * 5);
		font-weight: 700;
	}

	/* The count tile: a darkened cover with how many more there are. */
	.count::after {
		position: absolute;
		inset: 0;
		background: color-mix(in srgb, var(--text-primary) 45%, transparent);
		content: "";
	}

	.more {
		position: absolute;
		inset: 0;
		z-index: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--surface-page);
		font-size: calc(var(--u) * 8);
		font-weight: 700;
	}

	.chevron {
		display: inline-flex;
		color: var(--icon-muted);
	}
</style>
