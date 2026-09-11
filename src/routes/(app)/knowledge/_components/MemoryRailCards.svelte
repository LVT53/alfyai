<script lang="ts">
// The two explanatory cards at the bottom of the memory rail: how to read a
// row, and what the whole thing is for (with the two settings buttons that
// used to be reachable only from an empty category).
import { t } from "$lib/i18n";
import { Settings, Trash2 } from "@lucide/svelte";
</script>

<section class="rail-card" aria-labelledby="memory-legend-title">
	<h3 id="memory-legend-title" class="rail-card-title">
		{$t("memoryProfile.legendTitle")}
	</h3>

	<div class="legend-row">
		<span class="legend-dot legend-dot--stated" aria-hidden="true"></span>
		<div>
			<p class="legend-name">{$t("memoryProfile.legendStated")}</p>
			<p class="legend-body">{$t("memoryProfile.legendStatedBody")}</p>
		</div>
	</div>

	<div class="legend-row">
		<span class="legend-dot legend-dot--inferred" aria-hidden="true"></span>
		<div>
			<p class="legend-name">{$t("memoryProfile.legendInferred")}</p>
			<p class="legend-body">{$t("memoryProfile.legendInferredBody")}</p>
		</div>
	</div>

	<div class="legend-row">
		<span class="legend-chip legend-chip--scope" aria-hidden="true">
			{$t("memoryProfile.projectScope")}
		</span>
		<div>
			<p class="legend-name">{$t("memoryProfile.legendScope")}</p>
			<p class="legend-body">{$t("memoryProfile.legendScopeBody")}</p>
		</div>
	</div>

	<div class="legend-row">
		<span class="legend-chip legend-chip--expiry" aria-hidden="true">
			{$t("memoryProfile.legendExpiry")}
		</span>
		<div>
			<p class="legend-name">{$t("memoryProfile.legendExpiry")}</p>
			<p class="legend-body">{$t("memoryProfile.legendExpiryBody")}</p>
		</div>
	</div>
</section>

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
		border-radius: 1rem;
		background: var(--surface-elevated);
		padding: 0.85rem 0.95rem;
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

	.legend-row {
		display: flex;
		align-items: flex-start;
		gap: 0.6rem;
		padding: 0.5rem 0;
		border-top: 1px solid
			color-mix(in srgb, var(--border-default) 55%, transparent 45%);
	}

	.legend-name {
		margin: 0;
		font-family: var(--font-sans);
		font-size: 0.7rem;
		font-weight: 500;
		color: var(--text-primary);
	}

	.legend-body {
		margin: 0.12rem 0 0;
		font-family: var(--font-sans);
		font-size: 0.68rem;
		line-height: 1.5;
		color: var(--text-muted);
	}

	.legend-dot {
		flex-shrink: 0;
		width: 0.5rem;
		height: 0.5rem;
		margin-top: 0.3rem;
		border-radius: 9999px;
	}

	.legend-dot--stated {
		background: var(--accent);
	}

	.legend-dot--inferred {
		background: transparent;
		border: 1.5px solid var(--accent);
	}

	.legend-chip {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		height: 1.1rem;
		padding: 0 0.4rem;
		border-radius: 9999px;
		font-family: var(--font-sans);
		font-size: 0.6rem;
	}

	.legend-chip--scope {
		border: 1px solid var(--border-default);
		color: var(--text-muted);
	}

	.legend-chip--expiry {
		border: 1px solid
			color-mix(in srgb, var(--accent) 30%, var(--border-default) 70%);
		background: color-mix(in srgb, var(--accent) 6%, transparent 94%);
		color: var(--accent);
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
			border-color 150ms ease,
			background-color 150ms ease,
			color 150ms ease;
	}

	.rail-button:hover,
	.rail-button:focus-visible {
		border-color: var(--accent);
		color: var(--accent);
		background: color-mix(in srgb, var(--accent) 6%, transparent 94%);
	}

	.rail-button--danger {
		border-color: color-mix(in srgb, var(--danger) 30%, var(--border-default) 70%);
		color: var(--danger);
	}

	.rail-button--danger:hover,
	.rail-button--danger:focus-visible {
		border-color: var(--danger);
		color: var(--danger);
		background: color-mix(in srgb, var(--danger) 7%, transparent 93%);
	}

	@media (prefers-reduced-motion: reduce) {
		.rail-button {
			transition: none !important;
		}
	}
</style>
