<script lang="ts">
// Everyday redesign — the skills picker.
//
// Skills were reachable one way: type "$" and read a tray. That is a fine
// shortcut and a poor front door — it cannot be found by anyone who does not
// already know it exists, and on a phone it competes with the keyboard. The
// "+" menu's Skills row opens this instead: the same discovery endpoint the
// tray uses, with a search box that earns its place at a dozen skills, and
// one line per skill saying what it does — a skill name alone is not a
// description.
//
// A picker ends in Cancel and a positive button that NAMES what it is
// attaching, because you are choosing and then confirming. On a phone it is
// a full-screen sheet: the list can run to fifty rows and needs its own
// scroll.
import { Search } from "@lucide/svelte";
import { onMount } from "svelte";
import {
	discoverSkills,
	type SkillDiscoverySummary,
} from "$lib/client/api/skills";
import DialogShell from "$lib/components/ui/DialogShell.svelte";
import { t } from "$lib/i18n";

let {
	onSelect,
	onCancel,
	onManage,
}: {
	onSelect: (skill: SkillDiscoverySummary) => void;
	onCancel: () => void;
	onManage?: (() => void) | undefined;
} = $props();

let query = $state("");
let results = $state<SkillDiscoverySummary[]>([]);
let loading = $state(false);
let error = $state("");
let selectedId = $state<string | null>(null);
let requestId = 0;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

let selected = $derived(
	results.find((skill) => skill.id === selectedId) ?? null,
);

function describe(skill: SkillDiscoverySummary): string {
	if (skill.skillKind === "skill_variant" && skill.baseSkillDisplayName) {
		return `${skill.description} · ${$t("pendingSkill.variantBasedOn", {
			name: skill.baseSkillDisplayName,
		})}`;
	}
	return skill.description;
}

async function load(nextQuery: string) {
	requestId += 1;
	const id = requestId;
	loading = true;
	error = "";
	try {
		const skills = await discoverSkills(nextQuery);
		if (id !== requestId) return;
		results = skills;
		// A selection that survived a search that no longer contains it would
		// arm the positive button with something the list is not showing.
		if (selectedId && !skills.some((skill) => skill.id === selectedId)) {
			selectedId = null;
		}
	} catch {
		if (id !== requestId) return;
		results = [];
		error = $t("pendingSkill.discoveryError");
	} finally {
		if (id === requestId) loading = false;
	}
}

function handleQueryInput(event: Event) {
	query = (event.currentTarget as HTMLInputElement).value;
	if (debounceTimer) clearTimeout(debounceTimer);
	debounceTimer = setTimeout(() => void load(query.trim()), 160);
}

function confirm() {
	if (!selected) return;
	onSelect(selected);
}

onMount(() => {
	void load("");
	return () => {
		if (debounceTimer) clearTimeout(debounceTimer);
	};
});
</script>

{#snippet footer()}
	<button type="button" class="btn-secondary skills-picker__btn" onclick={onCancel}>
		{$t('common.cancel')}
	</button>
	<button
		type="button"
		class="btn-primary skills-picker__btn"
		data-testid="skills-picker-add"
		disabled={!selected}
		onclick={confirm}
	>
		{selected
			? $t('skillsPicker.add', { name: selected.displayName })
			: $t('skillsPicker.addNone')}
	</button>
{/snippet}

<DialogShell
	title={$t('skillsPicker.title')}
	onClose={onCancel}
	maxWidthClass="max-w-[30rem]"
	phonePresentation="fullSheet"
	titleVisuallyHidden
	{footer}
>
	<div class="skills-picker" data-testid="skills-picker">
		<header class="skills-picker__head">
			<h3 class="skills-picker__title">{$t('skillsPicker.title')}</h3>
			<p class="skills-picker__subtitle">
				{$t('skillsPicker.subtitle', { count: results.length })}
			</p>
		</header>

		<label class="skills-picker__search">
			<span class="skills-picker__search-icon" aria-hidden="true">
				<Search size={14} strokeWidth={2} />
			</span>
			<input
				type="search"
				data-testid="skills-picker-search"
				placeholder={$t('skillsPicker.search')}
				value={query}
				oninput={handleQueryInput}
				aria-label={$t('skillsPicker.search')}
			/>
		</label>

		{#if loading && results.length === 0}
			<p class="skills-picker__note" role="status">{$t('pendingSkill.discoveryLoading')}</p>
		{:else if error}
			<p class="skills-picker__note skills-picker__note--error" role="alert">{error}</p>
		{:else if results.length === 0}
			<p class="skills-picker__note" role="status">{$t('skillsPicker.empty')}</p>
		{:else}
			<ul class="skills-picker__list" role="radiogroup" aria-label={$t('skillsPicker.title')}>
				{#each results as skill (skill.id)}
					<li>
						<button
							type="button"
							role="radio"
							aria-checked={selectedId === skill.id}
							class="skills-picker__row"
							class:skills-picker__row--selected={selectedId === skill.id}
							data-testid={`skills-picker-row-${skill.id}`}
							onclick={() => (selectedId = skill.id)}
							ondblclick={() => { selectedId = skill.id; confirm(); }}
						>
							<span class="skills-picker__radio" aria-hidden="true"></span>
							<span class="skills-picker__copy">
								<span class="skills-picker__name">{skill.displayName}</span>
								<span class="skills-picker__desc">{describe(skill)}</span>
							</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}

		{#if onManage}
			<div class="skills-picker__manage-row">
				<span class="skills-picker__note skills-picker__note--inline">
					{$t('pendingSkill.user')}
				</span>
				<button type="button" class="skills-picker__manage" onclick={onManage}>
					{$t('skillsPicker.manage')}
				</button>
			</div>
		{/if}
	</div>
</DialogShell>

<style>
	.skills-picker {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		font-family: var(--font-sans);
	}

	.skills-picker__head {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}

	.skills-picker__title {
		margin: 0;
		font-size: var(--text-lg);
		font-weight: 700;
		line-height: 1.2;
		color: var(--text-primary);
	}

	.skills-picker__subtitle {
		margin: 0;
		font-size: var(--text-xs);
		color: var(--text-muted);
	}

	.skills-picker__search {
		position: relative;
		display: flex;
		align-items: center;
		gap: 0.45rem;
		min-height: 44px;
		border: 1px solid var(--border-default);
		border-radius: 0.55rem;
		background: var(--surface-elevated);
		padding: 0 0.6rem;
	}

	.skills-picker__search:focus-within {
		border-color: var(--focus-ring);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 30%, transparent 70%);
	}

	.skills-picker__search-icon {
		display: inline-flex;
		color: var(--text-muted);
	}

	.skills-picker__search input {
		flex: 1;
		min-width: 0;
		border: 0;
		background: transparent;
		color: var(--text-primary);
		font-size: var(--text-sm);
		outline: none;
	}

	.skills-picker__list {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		margin: 0;
		padding: 0;
		max-height: 22rem;
		overflow-y: auto;
		overscroll-behavior: contain;
		list-style: none;
	}

	.skills-picker__row {
		display: flex;
		align-items: flex-start;
		gap: 0.6rem;
		width: 100%;
		min-height: 44px;
		border: 0;
		border-radius: 0.5rem;
		background: transparent;
		padding: 0.5rem 0.5rem;
		text-align: left;
		cursor: pointer;
		transition: background-color var(--duration-standard) var(--ease-out);
	}

	.skills-picker__row:hover,
	.skills-picker__row:focus-visible {
		background: color-mix(in srgb, var(--accent) 10%, transparent);
		outline: none;
	}

	.skills-picker__row:focus-visible {
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 40%, transparent 60%);
	}

	.skills-picker__row--selected {
		background: color-mix(in srgb, var(--accent) 13%, transparent);
	}

	.skills-picker__radio {
		flex: 0 0 auto;
		width: 1rem;
		height: 1rem;
		margin-top: 0.12rem;
		border: 1.5px solid var(--border-default);
		border-radius: 999px;
		box-shadow: inset 0 0 0 3px var(--surface-page);
	}

	.skills-picker__row--selected .skills-picker__radio {
		border-color: var(--accent);
		background: var(--accent);
	}

	.skills-picker__copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 0.1rem;
	}

	.skills-picker__name {
		font-size: var(--text-sm);
		font-weight: 650;
		line-height: 1.2;
		color: var(--text-primary);
	}

	.skills-picker__desc {
		font-size: var(--text-xs);
		line-height: 1.3;
		color: var(--text-muted);
	}

	.skills-picker__note {
		margin: 0;
		padding: 0.75rem 0.2rem;
		font-size: var(--text-xs);
		color: var(--text-muted);
	}

	.skills-picker__note--inline {
		padding: 0;
	}

	.skills-picker__note--error {
		color: var(--danger);
	}

	.skills-picker__manage-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding-top: 0.3rem;
	}

	.skills-picker__manage {
		min-height: 44px;
		border: 1px solid var(--border-default);
		border-radius: 0.5rem;
		background: transparent;
		padding: 0 0.7rem;
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		cursor: pointer;
		transition: background-color var(--duration-standard) var(--ease-out);
	}

	.skills-picker__manage:hover,
	.skills-picker__manage:focus-visible {
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		outline: none;
	}

	.skills-picker__btn {
		min-height: 40px;
	}

	@media (prefers-reduced-motion: reduce) {
		.skills-picker__row,
		.skills-picker__manage {
			transition: none;
		}
	}
</style>
