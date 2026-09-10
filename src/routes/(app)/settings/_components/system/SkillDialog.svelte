<script lang="ts">
// Editing a skill opens the dialog chassis rather than growing a form inside
// the list, so the list never moves under you — and the four policy fields the
// old form posted as invisible defaults finally have controls.
import { AlertTriangle } from "@lucide/svelte";
import type { AdminSystemSkillDraft } from "$lib/client/api/admin";
import DialogShell from "$lib/components/ui/DialogShell.svelte";
import { t } from "$lib/i18n";
import ValueField from "./ValueField.svelte";
import SystemToggle from "./SystemToggle.svelte";
import "./system.css";

type Draft = AdminSystemSkillDraft & { activationExamplesText: string };

let {
	draft = $bindable(),
	isEdit = false,
	saving = false,
	error = "",
	onSave,
	onClose,
}: {
	draft: Draft;
	isEdit?: boolean;
	saving?: boolean;
	error?: string;
	onSave: () => void;
	onClose: () => void;
} = $props();

const DURATION = ["next_message", "session"] as const;
const QUESTION = ["none", "ask_when_needed"] as const;
const NOTES = ["none", "create_private_notes"] as const;
const SCOPE = [
	"selected_sources_only",
	"all_sources",
	"web_and_files",
] as const;
</script>

<DialogShell
	title={isEdit
		? $t('admin.system.skills.editTitle')
		: $t('admin.system.skills.createTitle')}
	description={$t('admin.system.skills.dialogHint')}
	maxWidthClass="max-w-[840px]"
	zIndexClass="z-[100]"
	{onClose}
>
	<div class="sys-grid3">
		<div>
			<label class="sys-label" for="SYSTEM_SKILL_DISPLAY_NAME">
				{$t('skills.displayName')}
			</label>
			<ValueField
				id="SYSTEM_SKILL_DISPLAY_NAME"
				size="wide"
				value={draft.displayName}
				placeholder={$t('admin.systemSkills.displayNamePlaceholder')}
				onchange={(next) => (draft.displayName = next)}
			/>
		</div>
		<div>
			<label class="sys-label" for="SYSTEM_SKILL_EXAMPLES">
				{$t('skills.activationExamples')}
			</label>
			<ValueField
				id="SYSTEM_SKILL_EXAMPLES"
				type="textarea"
				rows={2}
				value={draft.activationExamplesText}
				placeholder={$t('skills.activationExamplesPlaceholder')}
				onchange={(next) => (draft.activationExamplesText = next)}
			/>
			<p class="sys-help">{$t('admin.system.skills.activationHint')}</p>
		</div>
		<div>
			<label class="sys-label" for="SYSTEM_SKILL_DESCRIPTION">
				{$t('skills.description')}
			</label>
			<ValueField
				id="SYSTEM_SKILL_DESCRIPTION"
				size="wide"
				value={draft.description ?? ''}
				placeholder={$t('admin.systemSkills.descriptionPlaceholder')}
				onchange={(next) => (draft.description = next)}
			/>
		</div>
	</div>

	<div style="margin-top: var(--space-md)">
		<label class="sys-label" for="SYSTEM_SKILL_INSTRUCTIONS">
			{$t('skills.instructions')}
		</label>
		<ValueField
			id="SYSTEM_SKILL_INSTRUCTIONS"
			type="textarea"
			rows={6}
			value={draft.instructions}
			placeholder={$t('admin.systemSkills.instructionsPlaceholder')}
			onchange={(next) => (draft.instructions = next)}
		/>
	</div>

	<div class="sys-grid4" style="margin-top: var(--space-md)">
		<div>
			<label class="sys-label" for="SYSTEM_SKILL_DURATION">
				{$t('admin.system.skills.durationPolicy')}
			</label>
			<select
				id="SYSTEM_SKILL_DURATION"
				class="sys-input sys-input-wide"
				value={draft.durationPolicy ?? 'next_message'}
				onchange={(event) => {
					draft.durationPolicy = event.currentTarget
						.value as Draft['durationPolicy'];
				}}
			>
				{#each DURATION as option (option)}
					<option value={option}>
						{option === 'next_message'
							? $t('admin.system.skills.duration.next_message')
							: $t('admin.system.skills.duration.session')}
					</option>
				{/each}
			</select>
		</div>
		<div>
			<label class="sys-label" for="SYSTEM_SKILL_QUESTION">
				{$t('admin.system.skills.questionPolicy')}
			</label>
			<select
				id="SYSTEM_SKILL_QUESTION"
				class="sys-input sys-input-wide"
				value={draft.questionPolicy ?? 'ask_when_needed'}
				onchange={(event) => {
					draft.questionPolicy = event.currentTarget
						.value as Draft['questionPolicy'];
				}}
			>
				{#each QUESTION as option (option)}
					<option value={option}>
						{option === 'none'
							? $t('admin.system.skills.question.none')
							: $t('admin.system.skills.question.ask_when_needed')}
					</option>
				{/each}
			</select>
		</div>
		<div>
			<label class="sys-label" for="SYSTEM_SKILL_NOTES">
				{$t('admin.system.skills.notesPolicy')}
			</label>
			<select
				id="SYSTEM_SKILL_NOTES"
				class="sys-input sys-input-wide"
				value={draft.notesPolicy ?? 'none'}
				onchange={(event) => {
					draft.notesPolicy = event.currentTarget.value as Draft['notesPolicy'];
				}}
			>
				{#each NOTES as option (option)}
					<option value={option}>
						{option === 'none'
							? $t('admin.system.skills.notes.none')
							: $t('admin.system.skills.notes.create_private_notes')}
					</option>
				{/each}
			</select>
		</div>
		<div>
			<label class="sys-label" for="SYSTEM_SKILL_SCOPE">
				{$t('admin.system.skills.sourceScope')}
			</label>
			<select
				id="SYSTEM_SKILL_SCOPE"
				class="sys-input sys-input-wide"
				value={draft.sourceScope ?? 'selected_sources_only'}
				onchange={(event) => {
					draft.sourceScope = event.currentTarget.value as Draft['sourceScope'];
				}}
			>
				{#each SCOPE as option (option)}
					<option value={option}>
						{option === 'selected_sources_only'
							? $t('admin.system.skills.scope.selected_sources_only')
							: option === 'all_sources'
								? $t('admin.system.skills.scope.all_sources')
								: $t('admin.system.skills.scope.web_and_files')}
					</option>
				{/each}
			</select>
		</div>
	</div>

	<div class="sys-banner sys-banner-warn" style="margin-top: var(--space-md)">
		<span class="sys-banner-icon">
			<AlertTriangle size={14} strokeWidth={2} aria-hidden="true" />
		</span>
		<span>{$t('admin.system.skills.policyNote')}</span>
	</div>

	{#if error}
		<p class="sys-error" style="margin-top: var(--space-md)" role="alert">{error}</p>
	{/if}

	<div
		class="sys-row-control"
		style="margin-top: var(--space-lg); padding-top: var(--space-md); border-top: 1px solid var(--border-subtle)"
	>
		<SystemToggle
			id="SYSTEM_SKILL_ENABLED"
			label={$t('skills.enabled')}
			checked={draft.enabled ?? true}
			onchange={(next) => (draft.enabled = next)}
		/>
		<span class="sys-xs sys-muted">{$t('skills.enabled')}</span>
		<SystemToggle
			id="SYSTEM_SKILL_PUBLISHED"
			label={$t('admin.systemSkills.published')}
			checked={draft.published ?? false}
			onchange={(next) => (draft.published = next)}
		/>
		<span class="sys-xs sys-muted">{$t('admin.systemSkills.published')}</span>

		<span class="sys-grow"></span>
		<button type="button" class="btn-secondary btn-sm" onclick={onClose}>
			{$t('common.cancel')}
		</button>
		<button type="button" class="btn-primary btn-sm" disabled={saving} onclick={onSave}>
			{saving ? $t('common.saving') : $t('admin.systemSkills.save')}
		</button>
	</div>
</DialogShell>
