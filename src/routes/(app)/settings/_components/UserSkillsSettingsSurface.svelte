<script lang="ts">
	import { onMount } from "svelte";
	import { t } from "$lib/i18n";
	import {
		createUserSkill,
		deleteUserSkill,
		fetchUserSkills,
		updateUserSkill,
		type SkillDurationPolicy,
		type SkillNotesPolicy,
		type SkillQuestionPolicy,
		type SkillSourceScope,
		type UserSkill,
	} from "$lib/client/api/skills";

	let { skillsEnabled = true }: { skillsEnabled?: boolean } = $props();

	type Draft = {
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
	let draft = $state<Draft>(emptyDraft());
	let editingId = $state<string | null>(null);
	let loading = $state(false);
	let saving = $state(false);
	let deletingId = $state<string | null>(null);
	let message = $state("");
	let error = $state("");
	let validationError = $state("");

	function resetForm() {
		draft = emptyDraft();
		editingId = null;
		validationError = "";
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
		return skills.some(
			(skill) => skill.id !== editingId && skill.displayName.trim().toLocaleLowerCase() === normalized,
		);
	}

	function validateDraft(): boolean {
		validationError = "";
		if (!draft.displayName.trim()) {
			validationError = $t("skills.validation.displayNameRequired");
			return false;
		}
		if (!draft.instructions.trim()) {
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
			skills = await fetchUserSkills();
		} catch (loadError) {
			error = loadError instanceof Error ? loadError.message : $t("skills.errors.load");
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
			const saved = editingId
				? await updateUserSkill(editingId, input)
				: await createUserSkill(input);
			skills = editingId
				? skills.map((skill) => (skill.id === saved.id ? saved : skill))
				: [saved, ...skills];
			message = $t(editingId ? "skills.updated" : "skills.created");
			resetForm();
		} catch (saveError) {
			error = saveError instanceof Error ? saveError.message : $t("skills.errors.save");
		} finally {
			saving = false;
		}
	}

	function editSkill(skill: UserSkill) {
		editingId = skill.id;
		draft = {
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

	async function toggleSkill(skill: UserSkill) {
		error = "";
		const updated = await updateUserSkill(skill.id, { enabled: !skill.enabled }).catch((toggleError) => {
			error = toggleError instanceof Error ? toggleError.message : $t("skills.errors.save");
			return null;
		});
		if (updated) {
			skills = skills.map((item) => (item.id === updated.id ? updated : item));
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
			error = deleteError instanceof Error ? deleteError.message : $t("skills.errors.delete");
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
		{#if editingId}
			<button class="btn-secondary text-sm" type="button" onclick={resetForm}>
				{$t("skills.newSkill")}
			</button>
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
					<label class="settings-label" for="skill-instructions">{$t("skills.instructions")}</label>
					<textarea
						id="skill-instructions"
						class="settings-input min-h-28"
						bind:value={draft.instructions}
						placeholder={$t("skills.instructionsPlaceholder")}
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

				<button class="btn-primary self-start" type="submit" disabled={saving}>
					{saving ? $t("skills.saving") : $t("skills.save")}
				</button>
			</form>

			<div class="skills-list" aria-live="polite">
				{#if loading}
					<p class="text-sm text-text-secondary">{$t("skills.loading")}</p>
				{:else if skills.length === 0}
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
									class="btn-secondary text-sm"
									type="button"
									aria-label={$t("skills.editA11y", { name: skill.displayName })}
									onclick={() => editSkill(skill)}
								>
									{$t("skills.edit")}
								</button>
								<button
									class="btn-secondary text-sm"
									type="button"
									aria-label={$t(skill.enabled ? "skills.disableA11y" : "skills.enableA11y", {
										name: skill.displayName,
									})}
									onclick={() => void toggleSkill(skill)}
								>
									{skill.enabled ? $t("skills.disable") : $t("skills.enable")}
								</button>
								<button
									class="btn-ghost text-sm"
									style="color: var(--color-danger);"
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
		border-color: var(--text-tertiary);
		color: var(--text-tertiary);
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
