<script lang="ts">
import { onMount } from "svelte";
import { t } from "$lib/i18n";
import {
	createUserSkill,
	createUserSkillVariant,
	deleteUserSkill,
	deleteUserSkillVariant,
	fetchSystemSkillSummaries,
	fetchUserSkills,
	fetchUserSkillVariants,
	updateUserSkill,
	updateUserSkillVariant,
	type SkillDurationPolicy,
	type SkillNotesPolicy,
	type SkillQuestionPolicy,
	type SkillSourceScope,
	type SystemSkillSummary,
	type UserSkill,
	type UserSkillVariant,
} from "$lib/client/api/skills";

let { skillsEnabled = true }: { skillsEnabled?: boolean } = $props();

type Draft = {
	skillKind: "user_skill" | "skill_variant";
	baseSkillId: string;
	displayName: string;
	description: string;
	instructions: string;
	activationExamplesText: string;
	enabled: boolean;
	durationPolicy: SkillDurationPolicy;
	questionPolicy: SkillQuestionPolicy;
	notesPolicy: SkillNotesPolicy;
	sourceScope: SkillSourceScope;
};

const emptyDraft = (): Draft => ({
	skillKind: "user_skill",
	baseSkillId: "",
	displayName: "",
	description: "",
	instructions: "",
	activationExamplesText: "",
	enabled: true,
	durationPolicy: "next_message",
	questionPolicy: "none",
	notesPolicy: "none",
	sourceScope: "current_conversation",
});

let skills = $state<UserSkill[]>([]);
let variants = $state<UserSkillVariant[]>([]);
let packs = $state<SystemSkillSummary[]>([]);
let draft = $state<Draft>(emptyDraft());
let editingId = $state<string | null>(null);
let loading = $state(false);
let saving = $state(false);
let deletingId = $state<string | null>(null);
let message = $state("");
let error = $state("");
let validationError = $state("");
let editingKind = $state<"user_skill" | "skill_variant">("user_skill");

const selectedPack = $derived(
	packs.find((pack) => pack.id === draft.baseSkillId) ?? null,
);

function resetForm() {
	draft = emptyDraft();
	editingId = null;
	editingKind = "user_skill";
	validationError = "";
}

function startNewVariant() {
	draft = { ...emptyDraft(), skillKind: "skill_variant" };
	editingId = null;
	editingKind = "skill_variant";
	validationError = "";
	message = "";
	error = "";
}

function startNewUserSkill() {
	resetForm();
}

function selectDraftKind(skillKind: "user_skill" | "skill_variant") {
	if (draft.skillKind === skillKind) return;
	draft = {
		...draft,
		skillKind,
		baseSkillId: skillKind === "skill_variant" ? draft.baseSkillId : "",
	};
	editingId = null;
	editingKind = skillKind;
	validationError = "";
	message = "";
	error = "";
}

function examplesFromText(text: string): string[] {
	return text
		.split("\n")
		.map((item) => item.trim())
		.filter(Boolean);
}

function duplicateName(): boolean {
	const normalized = draft.displayName.trim().toLocaleLowerCase();
	if (!normalized) return false;
	return [...skills, ...variants].some(
		(skill) =>
			skill.id !== editingId &&
			skill.displayName.trim().toLocaleLowerCase() === normalized,
	);
}

function validateDraft(): boolean {
	validationError = "";
	if (!draft.displayName.trim()) {
		validationError = $t("skills.validation.displayNameRequired");
		return false;
	}
	if (draft.skillKind === "skill_variant" && !draft.baseSkillId) {
		validationError = $t("skills.variant.validation.packRequired");
		return false;
	}
	if (draft.skillKind === "user_skill" && !draft.instructions.trim()) {
		validationError = $t("skills.validation.instructionsRequired");
		return false;
	}
	return true;
}

async function loadSkills() {
	if (!skillsEnabled) return;
	loading = true;
	error = "";
	try {
		const [loadedSkills, loadedVariants, loadedPacks] = await Promise.all([
			fetchUserSkills(),
			fetchUserSkillVariants(),
			fetchSystemSkillSummaries(),
		]);
		skills = loadedSkills;
		variants = loadedVariants;
		packs = loadedPacks;
	} catch (loadError) {
		error =
			loadError instanceof Error ? loadError.message : $t("skills.errors.load");
	} finally {
		loading = false;
	}
}

async function saveSkill() {
	message = "";
	error = "";
	if (!validateDraft()) return;

	saving = true;
	const input = {
		displayName: draft.displayName,
		description: draft.description,
		instructions: draft.instructions,
		activationExamples: examplesFromText(draft.activationExamplesText),
		enabled: draft.enabled,
		durationPolicy: draft.durationPolicy,
		questionPolicy: draft.questionPolicy,
		notesPolicy: draft.notesPolicy,
		sourceScope: draft.sourceScope,
	};

	try {
		if (draft.skillKind === "skill_variant") {
			const variantInput = {
				baseSkillId: draft.baseSkillId,
				displayName: draft.displayName,
				description: draft.description,
				instructions: draft.instructions,
				activationExamples: examplesFromText(draft.activationExamplesText),
				enabled: draft.enabled,
			};
			const saved = editingId
				? await updateUserSkillVariant(editingId, variantInput)
				: await createUserSkillVariant(variantInput);
			variants = editingId
				? variants.map((variant) => (variant.id === saved.id ? saved : variant))
				: [saved, ...variants];
		} else {
			const saved = editingId
				? await updateUserSkill(editingId, input)
				: await createUserSkill(input);
			skills = editingId
				? skills.map((skill) => (skill.id === saved.id ? saved : skill))
				: [saved, ...skills];
		}
		message = $t(editingId ? "skills.updated" : "skills.created");
		resetForm();
	} catch (saveError) {
		error =
			saveError instanceof Error ? saveError.message : $t("skills.errors.save");
	} finally {
		saving = false;
	}
}

function editSkill(skill: UserSkill) {
	editingId = skill.id;
	editingKind = "user_skill";
	draft = {
		skillKind: "user_skill",
		baseSkillId: "",
		displayName: skill.displayName,
		description: skill.description,
		instructions: skill.instructions,
		activationExamplesText: skill.activationExamples.join("\n"),
		enabled: skill.enabled,
		durationPolicy: skill.durationPolicy,
		questionPolicy: skill.questionPolicy,
		notesPolicy: skill.notesPolicy,
		sourceScope: skill.sourceScope,
	};
	validationError = "";
	message = "";
	error = "";
}

function editVariant(variant: UserSkillVariant) {
	editingId = variant.id;
	editingKind = "skill_variant";
	draft = {
		...emptyDraft(),
		skillKind: "skill_variant",
		baseSkillId: variant.baseSkillId,
		displayName: variant.displayName,
		description: variant.description,
		instructions: variant.instructions,
		activationExamplesText: variant.activationExamples.join("\n"),
		enabled: variant.enabled,
	};
	validationError = "";
	message = "";
	error = "";
}

async function toggleSkill(skill: UserSkill) {
	error = "";
	const updated = await updateUserSkill(skill.id, {
		enabled: !skill.enabled,
	}).catch((toggleError) => {
		error =
			toggleError instanceof Error
				? toggleError.message
				: $t("skills.errors.save");
		return null;
	});
	if (updated) {
		skills = skills.map((item) => (item.id === updated.id ? updated : item));
	}
}

async function toggleVariant(variant: UserSkillVariant) {
	error = "";
	const updated = await updateUserSkillVariant(variant.id, {
		enabled: !variant.enabled,
	}).catch((toggleError) => {
		error =
			toggleError instanceof Error
				? toggleError.message
				: $t("skills.errors.save");
		return null;
	});
	if (updated) {
		variants = variants.map((item) =>
			item.id === updated.id ? updated : item,
		);
	}
}

async function removeSkill(skill: UserSkill) {
	if (!confirm($t("skills.deleteConfirm", { name: skill.displayName }))) return;
	deletingId = skill.id;
	error = "";
	try {
		await deleteUserSkill(skill.id);
		skills = skills.filter((item) => item.id !== skill.id);
		if (editingId === skill.id) resetForm();
		message = $t("skills.deleted");
	} catch (deleteError) {
		error =
			deleteError instanceof Error
				? deleteError.message
				: $t("skills.errors.delete");
	} finally {
		deletingId = null;
	}
}

async function removeVariant(variant: UserSkillVariant) {
	if (
		!confirm($t("skills.variant.deleteConfirm", { name: variant.displayName }))
	)
		return;
	deletingId = variant.id;
	error = "";
	try {
		await deleteUserSkillVariant(variant.id);
		variants = variants.filter((item) => item.id !== variant.id);
		if (editingId === variant.id) resetForm();
		message = $t("skills.deleted");
	} catch (deleteError) {
		error =
			deleteError instanceof Error
				? deleteError.message
				: $t("skills.errors.delete");
	} finally {
		deletingId = null;
	}
}

onMount(() => {
	void loadSkills();
});
</script>

<section class="settings-card mb-4">
	<div class="mb-4 flex flex-wrap items-center justify-between gap-3">
		<h2 class="settings-section-title mb-0">{$t("skills.title")}</h2>
		{#if skillsEnabled}
			<div class="flex flex-wrap gap-2">
				<button class="btn-secondary" type="button" onclick={startNewUserSkill}>
					{$t("skills.newSkill")}
				</button>
				<button class="btn-secondary" type="button" onclick={startNewVariant}>
					{$t("skills.variant.new")}
				</button>
			</div>
		{/if}
	</div>

	{#if !skillsEnabled}
		<p class="text-sm text-text-secondary">{$t("skills.disabled")}</p>
	{:else}
		<div class="skills-grid">
			<form
				class="flex flex-col gap-3"
				onsubmit={(event) => {
					event.preventDefault();
					void saveSkill();
				}}
			>
				<div class="skill-kind-tabs" role="group" aria-label={$t("skills.kindTabs")}>
					<button
						type="button"
						class:active={draft.skillKind === "user_skill"}
						aria-pressed={draft.skillKind === "user_skill"}
						onclick={() => selectDraftKind("user_skill")}
					>
						{$t("skills.kind.userSkill")}
					</button>
					<button
						type="button"
						class:active={draft.skillKind === "skill_variant"}
						aria-pressed={draft.skillKind === "skill_variant"}
						onclick={() => selectDraftKind("skill_variant")}
					>
						{$t("skills.kind.variant")}
					</button>
				</div>

				{#if draft.skillKind === "skill_variant"}
					<div>
						<label class="settings-label" for="skill-base-pack">{$t("skills.variant.pack")}</label>
						<select
							id="skill-base-pack"
							class="settings-input"
							bind:value={draft.baseSkillId}
							disabled={editingKind === "skill_variant" && Boolean(editingId)}
						>
							<option value="">{$t("skills.variant.packPlaceholder")}</option>
							{#each packs as pack (pack.id)}
								<option value={pack.id}>{pack.displayName}</option>
							{/each}
						</select>
						{#if loading}
							<p class="mt-1 text-sm text-text-secondary">{$t("skills.variant.packsLoading")}</p>
						{:else if packs.length === 0}
							<p class="mt-1 text-sm text-text-secondary">{$t("skills.variant.noPacks")}</p>
						{:else if draft.baseSkillId && !selectedPack}
							<p class="mt-1 text-sm text-danger">{$t("skills.variant.packUnavailable")}</p>
						{/if}
					</div>
					{#if selectedPack}
						<div class="skill-pack-info">
							<p class="text-sm font-semibold text-text-primary">{selectedPack.displayName}</p>
							<p class="text-sm text-text-secondary">{selectedPack.description}</p>
							<p class="text-xs text-text-muted">{$t("skills.variant.inheritedPolicies")}</p>
						</div>
					{/if}
				{/if}

				<div>
					<label class="settings-label" for="skill-display-name">{$t("skills.displayName")}</label>
					<input
						id="skill-display-name"
						class="settings-input"
						type="text"
						bind:value={draft.displayName}
						placeholder={$t("skills.displayNamePlaceholder")}
					/>
				</div>

				<div>
					<label class="settings-label" for="skill-description">{$t("skills.description")}</label>
					<textarea
						id="skill-description"
						class="settings-input min-h-20"
						bind:value={draft.description}
						placeholder={$t("skills.descriptionPlaceholder")}
					></textarea>
				</div>

				<div>
					<label class="settings-label" for="skill-instructions">
						{draft.skillKind === "skill_variant" ? $t("skills.variant.overlay") : $t("skills.instructions")}
					</label>
					<textarea
						id="skill-instructions"
						class="settings-input min-h-28"
						bind:value={draft.instructions}
						placeholder={draft.skillKind === "skill_variant" ? $t("skills.variant.overlayPlaceholder") : $t("skills.instructionsPlaceholder")}
					></textarea>
				</div>

				<div>
					<label class="settings-label" for="skill-activation-examples">
						{$t("skills.activationExamples")}
					</label>
					<textarea
						id="skill-activation-examples"
						class="settings-input min-h-20"
						bind:value={draft.activationExamplesText}
						placeholder={$t("skills.activationExamplesPlaceholder")}
					></textarea>
				</div>

				<label class="flex items-center gap-2 text-sm text-text-secondary">
					<input type="checkbox" bind:checked={draft.enabled} />
					{$t("skills.enabled")}
				</label>

				{#if draft.skillKind === "user_skill"}
				<div class="skills-policy-grid">
					<label class="settings-label" for="skill-duration-policy">
						{$t("skills.durationPolicy")}
						<select id="skill-duration-policy" class="settings-input mt-1" bind:value={draft.durationPolicy}>
							<option value="next_message">{$t("skills.duration.nextMessage")}</option>
							<option value="session">{$t("skills.duration.session")}</option>
						</select>
					</label>
					<label class="settings-label" for="skill-question-policy">
						{$t("skills.questionPolicy")}
						<select id="skill-question-policy" class="settings-input mt-1" bind:value={draft.questionPolicy}>
							<option value="none">{$t("skills.question.none")}</option>
							<option value="ask_when_needed">{$t("skills.question.askWhenNeeded")}</option>
						</select>
					</label>
					<label class="settings-label" for="skill-notes-policy">
						{$t("skills.notesPolicy")}
						<select id="skill-notes-policy" class="settings-input mt-1" bind:value={draft.notesPolicy}>
							<option value="none">{$t("skills.notes.none")}</option>
							<option value="create_private_notes">{$t("skills.notes.createPrivate")}</option>
						</select>
					</label>
					<label class="settings-label" for="skill-source-scope">
						{$t("skills.sourceScope")}
						<select id="skill-source-scope" class="settings-input mt-1" bind:value={draft.sourceScope}>
							<option value="current_conversation">{$t("skills.source.currentConversation")}</option>
							<option value="selected_sources_only">{$t("skills.source.selectedSourcesOnly")}</option>
						</select>
					</label>
				</div>
				{:else}
					<p class="text-sm text-text-secondary">{$t("skills.variant.inheritedPolicyCopy")}</p>
				{/if}

				{#if duplicateName()}
					<p class="skill-warning text-sm">{$t("skills.duplicateWarning")}</p>
				{/if}
				{#if validationError}
					<p class="text-sm text-danger">{validationError}</p>
				{/if}
				{#if message}
					<p class="text-sm text-success">{message}</p>
				{/if}
				{#if error}
					<p class="text-sm text-danger">{error}</p>
				{/if}

				<button class="btn-primary self-start" type="submit" disabled={saving || (draft.skillKind === "skill_variant" && packs.length === 0)}>
					{saving ? $t("skills.saving") : $t("skills.save")}
				</button>
			</form>

			<div class="skills-list" aria-live="polite">
				{#if loading}
					<p class="text-sm text-text-secondary">{$t("skills.loading")}</p>
				{:else if skills.length === 0 && variants.length === 0}
					<p class="text-sm text-text-secondary">{$t("skills.empty")}</p>
				{:else}
					{#each skills as skill (skill.id)}
						<article class="skill-row">
							<div class="min-w-0">
								<div class="flex flex-wrap items-center gap-2">
									<h3 class="truncate text-sm font-semibold text-text-primary">{skill.displayName}</h3>
									<span class="skill-status" class:skill-status-disabled={!skill.enabled}>
										{skill.enabled ? $t("skills.status.enabled") : $t("skills.status.disabled")}
									</span>
								</div>
								{#if skill.description}
									<p class="mt-1 line-clamp-2 text-sm text-text-secondary">{skill.description}</p>
								{/if}
							</div>
							<div class="flex flex-wrap gap-2">
								<button
									class="btn-secondary"
									type="button"
									aria-label={$t("skills.editA11y", { name: skill.displayName })}
									onclick={() => editSkill(skill)}
								>
									{$t("skills.edit")}
								</button>
								<button
									class="btn-secondary"
									type="button"
									aria-label={$t(skill.enabled ? "skills.disableA11y" : "skills.enableA11y", {
										name: skill.displayName,
									})}
									onclick={() => void toggleSkill(skill)}
								>
									{skill.enabled ? $t("skills.disable") : $t("skills.enable")}
								</button>
								<button
									class="btn-ghost"
									style="color: var(--danger);"
									type="button"
									disabled={deletingId === skill.id}
									aria-label={$t("skills.deleteA11y", { name: skill.displayName })}
									onclick={() => void removeSkill(skill)}
								>
									{deletingId === skill.id ? $t("skills.deleting") : $t("skills.delete")}
								</button>
							</div>
						</article>
					{/each}
					{#each variants as variant (variant.id)}
						<article class="skill-row">
							<div class="min-w-0">
								<div class="flex flex-wrap items-center gap-2">
									<h3 class="truncate text-sm font-semibold text-text-primary">{variant.displayName}</h3>
									<span class="skill-kind-badge">{$t("skills.kind.variant")}</span>
									<span class="skill-status" class:skill-status-disabled={!variant.enabled}>
										{variant.enabled ? $t("skills.status.enabled") : $t("skills.status.disabled")}
									</span>
								</div>
								<p class="mt-1 text-sm text-text-secondary">
									{$t("skills.variant.basedOn", { name: variant.baseSkillDisplayName ?? $t("skills.variant.unknownPack") })}
								</p>
								{#if variant.baseSkillAvailable === false}
									<p class="mt-1 text-sm text-danger">{$t("skills.variant.packUnavailable")}</p>
								{/if}
								{#if variant.description}
									<p class="mt-1 line-clamp-2 text-sm text-text-secondary">{variant.description}</p>
								{/if}
							</div>
							<div class="flex flex-wrap gap-2">
								<button
									class="btn-secondary"
									type="button"
									aria-label={$t("skills.editA11y", { name: variant.displayName })}
									onclick={() => editVariant(variant)}
								>
									{$t("skills.edit")}
								</button>
								<button
									class="btn-secondary"
									type="button"
									aria-label={$t(variant.enabled ? "skills.disableA11y" : "skills.enableA11y", {
										name: variant.displayName,
									})}
									onclick={() => void toggleVariant(variant)}
								>
									{variant.enabled ? $t("skills.disable") : $t("skills.enable")}
								</button>
								<button
									class="btn-ghost"
									style="color: var(--danger);"
									type="button"
									disabled={deletingId === variant.id}
									aria-label={$t("skills.deleteA11y", { name: variant.displayName })}
									onclick={() => void removeVariant(variant)}
								>
									{deletingId === variant.id ? $t("skills.deleting") : $t("skills.delete")}
								</button>
							</div>
						</article>
					{/each}
				{/if}
			</div>
		</div>
	{/if}
</section>

<style>
	.skills-grid {
		display: grid;
		grid-template-columns: minmax(0, 1.1fr) minmax(18rem, 0.9fr);
		gap: 1rem;
	}

	.skills-policy-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.75rem;
	}

	.skill-kind-tabs {
		display: inline-flex;
		width: fit-content;
		gap: 0.25rem;
		padding: 0.25rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-page);
	}

	.skill-kind-tabs button {
		border-radius: var(--radius-sm);
		padding: 0.375rem 0.625rem;
		font-size: 0.875rem;
		color: var(--text-secondary);
	}

	.skill-kind-tabs button.active {
		background: var(--surface-elevated);
		color: var(--text-primary);
	}

	.skill-pack-info {
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-page);
		padding: 0.75rem;
	}

	.skills-list {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-height: 4rem;
	}

	.skill-row {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.75rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-page);
	}

	.skill-status {
		border: 1px solid var(--success);
		border-radius: var(--radius-full);
		color: var(--success);
		font-size: 0.6875rem;
		line-height: 1;
		padding: 0.1875rem 0.4375rem;
	}

	.skill-status-disabled {
		border-color: color-mix(in srgb, var(--text-muted) 72%, transparent 28%);
		color: var(--text-muted);
	}

	.skill-kind-badge {
		border: 1px solid var(--border-default);
		border-radius: var(--radius-full);
		color: var(--text-secondary);
		font-size: 0.6875rem;
		line-height: 1;
		padding: 0.1875rem 0.4375rem;
	}

	.skill-warning {
		color: var(--accent);
	}

	@media (max-width: 820px) {
		.skills-grid,
		.skills-policy-grid {
			grid-template-columns: 1fr;
		}

		.skill-row {
			flex-direction: column;
		}
	}
</style>
