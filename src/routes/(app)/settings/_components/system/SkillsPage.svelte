<script lang="ts">
import { MoreVertical, Pencil, Plus } from "@lucide/svelte";
import { slide } from "svelte/transition";
import type { AdminSystemSkill } from "$lib/client/api/admin";
import { t } from "$lib/i18n";
import { reducedMotionAware } from "$lib/utils/motion";
import SystemCard from "./SystemCard.svelte";
import SystemToggle from "./SystemToggle.svelte";
import "./system.css";

const menuSlide = reducedMotionAware(slide);

let {
	skills = [],
	loading = false,
	error = "",
	message = "",
	onNew,
	onEdit,
	onToggleEnabled,
	onTogglePublished,
}: {
	skills?: AdminSystemSkill[];
	loading?: boolean;
	error?: string;
	message?: string;
	onNew: () => void;
	onEdit: (skill: AdminSystemSkill) => void;
	onToggleEnabled: (skill: AdminSystemSkill, enabled: boolean) => void;
	onTogglePublished: (skill: AdminSystemSkill, published: boolean) => void;
} = $props();

let menuSkillId = $state<string | null>(null);
</script>

<svelte:window
	onkeydown={(event) => {
		if (event.key === 'Escape') menuSkillId = null;
	}}
/>

<SystemCard
	title={$t('admin.system.skills.title')}
	description={$t('admin.system.skills.description')}
	testId="system-page-skills"
>
	{#snippet actions()}
		<button type="button" class="btn-primary btn-sm" onclick={onNew}>
			<Plus size={13} strokeWidth={2} aria-hidden="true" />
			{$t('admin.system.skills.new')}
		</button>
	{/snippet}

	{#if loading}
		<p class="sys-sm sys-muted">{$t('admin.systemSkills.loading')}</p>
	{:else if error}
		<p class="sys-error" role="alert">{error}</p>
	{:else if skills.length === 0}
		<div class="sys-empty">{$t('admin.systemSkills.empty')}</div>
	{:else}
		<div class="sys-list">
			{#each skills as skill (skill.id)}
				<div class="sys-list-row" data-testid={`skill-row-${skill.id}`}>
					<span
						class="sys-dot"
						class:sys-dot-on={skill.enabled}
						class:sys-dot-off={!skill.enabled}
					></span>
					<span class="sys-grow" style="min-width: 0">
						<span class="sys-label">
							<span class="sys-truncate">{skill.displayName}</span>
							<span
								class="sys-pill"
								class:sys-pill-ok={skill.published}
								class:sys-pill-muted={!skill.published}
							>
								{skill.published
									? $t('admin.systemSkills.status.published')
									: $t('admin.systemSkills.status.draft')}
							</span>
						</span>
						<p class="sys-help">{skill.description}</p>
					</span>

					<SystemToggle
						label={skill.enabled
							? $t('skills.disableA11y', { name: skill.displayName })
							: $t('skills.enableA11y', { name: skill.displayName })}
						checked={skill.enabled}
						onchange={(next) => onToggleEnabled(skill, next)}
					/>
					<span class="sys-chip sys-chip-live">
						{$t('admin.system.appliesImmediately')}
					</span>

					<button
						type="button"
						class="sys-mini"
						aria-label={$t('skills.editA11y', { name: skill.displayName })}
						onclick={() => onEdit(skill)}
					>
						<Pencil size={12} strokeWidth={2} aria-hidden="true" />
						{$t('common.edit')}
					</button>

					<span style="position: relative">
						<button
							type="button"
							class="sys-mini"
							aria-haspopup="menu"
							aria-expanded={menuSkillId === skill.id}
							aria-label={$t('admin.system.skills.menu', { name: skill.displayName })}
							onclick={() => (menuSkillId = menuSkillId === skill.id ? null : skill.id)}
						>
							<MoreVertical size={14} strokeWidth={2} aria-hidden="true" />
						</button>
						{#if menuSkillId === skill.id}
							<div class="sys-menu" role="menu" transition:menuSlide={{ duration: 140 }}>
								<button
									type="button"
									role="menuitem"
									class="sys-menu-item"
									aria-label={skill.published
										? undefined
										: $t('admin.systemSkills.publishA11y', { name: skill.displayName })}
									onclick={() => {
										menuSkillId = null;
										onTogglePublished(skill, !skill.published);
									}}
								>
									{skill.published
										? $t('admin.system.skills.unpublish')
										: $t('admin.systemSkills.publish')}
								</button>
							</div>
						{/if}
					</span>
				</div>
			{/each}
		</div>
	{/if}

	{#if message}
		<p class="sys-sm" style="color: var(--success); margin-top: var(--space-sm)" role="status">
			{message}
		</p>
	{/if}
</SystemCard>
