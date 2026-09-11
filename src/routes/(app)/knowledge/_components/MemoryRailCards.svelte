<script lang="ts">
// What the memory tab is for, with the two settings buttons that used to be
// reachable only from an empty category. "Reading a row" used to be a second
// card here; it is a tooltip on the portrait's title now, beside the rows it
// explains rather than three scrolls below them.
import { t } from "$lib/i18n";
import { Settings, Trash2 } from "@lucide/svelte";
</script>

<section class="rail-card" aria-labelledby="memory-about-title">
	<h3 id="memory-about-title" class="rail-card-title">
		{$t("memoryProfile.aboutTitle")}
	</h3>
	<p class="rail-card-body">{$t("memoryProfile.aboutBody")}</p>
	<div class="rail-card-actions">
		<a class="rail-button" href="/settings?section=memory">
			<Settings size={12} strokeWidth={2.1} aria-hidden="true" />
			<span>{$t("memoryProfile.memorySettings")}</span>
		</a>
		<!-- Clearing lives in the danger section, not on the memory on/off row. -->
		<a class="rail-button rail-button--danger" href="/settings?section=danger">
			<Trash2 size={12} strokeWidth={2.1} aria-hidden="true" />
			<span>{$t("memoryProfile.clearMemory")}</span>
		</a>
	</div>
</section>

<style>
	.rail-card {
		border: 1px solid var(--border-default);
		border-radius: var(--knowledge-card-radius, 1rem);
		background: var(--surface-elevated);
		padding: var(--knowledge-card-padding-y, 0.85rem)
			var(--knowledge-card-padding-x, 0.95rem);
		box-shadow: var(--shadow-sm, 0 1px 2px rgba(0, 0, 0, 0.04));
	}

	.rail-card-title {
		margin: 0;
		font-family: var(--font-sans);
		font-size: 0.82rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.rail-card-body {
		margin: 0.35rem 0 0;
		font-family: var(--font-sans);
		font-size: 0.7rem;
		line-height: 1.6;
		color: var(--text-muted);
	}

	.rail-card-actions {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		margin-top: 0.75rem;
	}

	.rail-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.35rem;
		height: 2rem;
		padding: 0 0.7rem;
		border: 1px solid var(--border-default);
		border-radius: 0.5rem;
		background: transparent;
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: 0.72rem;
		font-weight: 500;
		text-decoration: none;
		cursor: pointer;
		transition:
			border-color var(--duration-standard) var(--ease-out),
			background-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	/* The same 12%/38% → 18%/55% step every other button on the page takes. */
	.rail-button:hover,
	.rail-button:focus-visible {
		border-color: color-mix(in srgb, var(--accent) 55%, transparent);
		color: var(--accent);
		background: color-mix(in srgb, var(--accent) 12%, transparent);
	}

	.rail-button:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.rail-button--danger {
		border-color: color-mix(in srgb, var(--danger) 38%, transparent);
		color: var(--danger);
	}

	.rail-button--danger:hover,
	.rail-button--danger:focus-visible {
		border-color: color-mix(in srgb, var(--danger) 55%, transparent);
		color: var(--danger);
		background: color-mix(in srgb, var(--danger) 18%, transparent);
	}

	@media (prefers-reduced-motion: reduce) {
		.rail-button {
			transition: none !important;
		}
	}
</style>
