<script lang="ts">
import type {
	FocusContinuityItem,
	PersonaMemoryItem,
	TaskMemoryItem,
} from "$lib/types";
import type {
	FocusContinuityView,
	MemoryModal,
	PersonaMemoryFilter,
} from "../_helpers";
import {
	formatMemoryTimestamp,
	formatPersonaActor,
	formatPersonaClass,
	formatPersonaOrigin,
	formatPersonaSource,
	getPersonaRowKey,
	personaMemoryFilters,
} from "../_helpers";
import { t } from "$lib/i18n";
import { X } from "@lucide/svelte";

let {
	activeMemoryModal,
	memoryLoading,
	memoryLoaded,
	memoryLoadError,
	honchoEnabled,
	personaMemories,
	filteredPersonaMemories,
	personaMemoryFilter,
	personaMemoryStateCounts,
	selectedPersonaMemoryIds,
	taskMemories,
	selectedTaskMemoryIds,
	focusContinuities,
	selectedFocusContinuityIds,
	focusContinuityView,
	userDisplayName,
	isMemoryActionPending,
	onClose,
	onSetPersonaMemoryFilter,
	onSetFocusContinuityView,
	onTogglePersonaSelection,
	onToggleAllPersonaSelections,
	onToggleTaskSelection,
	onToggleAllTaskSelections,
	onToggleFocusContinuitySelection,
	onToggleAllFocusContinuitySelections,
	onRunBulkPersonaForget,
	onRunBulkTaskForget,
	onRunBulkFocusContinuityForget,
	onRunMemoryAction,
}: {
	activeMemoryModal: Exclude<MemoryModal, null>;
	memoryLoading: boolean;
	memoryLoaded: boolean;
	memoryLoadError: string;
	honchoEnabled: boolean;
	personaMemories: PersonaMemoryItem[];
	filteredPersonaMemories: PersonaMemoryItem[];
	personaMemoryFilter: PersonaMemoryFilter;
	personaMemoryStateCounts: Record<PersonaMemoryFilter, number>;
	selectedPersonaMemoryIds: string[];
	taskMemories: TaskMemoryItem[];
	selectedTaskMemoryIds: string[];
	focusContinuities: FocusContinuityItem[];
	selectedFocusContinuityIds: string[];
	focusContinuityView: FocusContinuityView;
	userDisplayName: string;
	isMemoryActionPending: (key: string) => boolean;
	onClose: () => void;
	onSetPersonaMemoryFilter: (filter: PersonaMemoryFilter) => void;
	onSetFocusContinuityView: (view: FocusContinuityView) => void;
	onTogglePersonaSelection: (id: string) => void;
	onToggleAllPersonaSelections: () => void;
	onToggleTaskSelection: (id: string) => void;
	onToggleAllTaskSelections: () => void;
	onToggleFocusContinuitySelection: (id: string) => void;
	onToggleAllFocusContinuitySelections: () => void;
	onRunBulkPersonaForget: () => void | Promise<void>;
	onRunBulkTaskForget: () => void | Promise<void>;
	onRunBulkFocusContinuityForget: () => void | Promise<void>;
	onRunMemoryAction: (
		payload: Record<string, unknown>,
		key: string,
		confirmationMessage?: string,
	) => void | Promise<void>;
} = $props();
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div
	class="fixed inset-0 z-[120] flex items-center justify-center bg-surface-overlay/65 p-4 backdrop-blur-sm"
	role="presentation"
	onclick={onClose}
>
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div
		role="dialog"
		aria-modal="true"
		aria-labelledby={activeMemoryModal === 'persona' ? 'persona-memory-dialog-title' : 'focus-memory-dialog-title'}
		tabindex={-1}
		class="max-h-[88vh] w-full max-w-[1100px] overflow-hidden rounded-[1.6rem] border border-border bg-surface-elevated shadow-2xl"
		onclick={(event) => event.stopPropagation()}
	>
		<div class="flex items-start justify-between gap-4 border-b border-border px-5 py-4 md:px-6">
			<div>
				<div class="text-[0.72rem] font-sans uppercase tracking-[0.12em] text-text-muted">
					{activeMemoryModal === 'persona' ? $t('memory.personaMemory') : $t('memory.focusContinuity')}
				</div>
				<h3
					id={activeMemoryModal === 'persona' ? 'persona-memory-dialog-title' : 'focus-memory-dialog-title'}
					class="mt-2 text-xl font-serif tracking-[-0.03em] text-text-primary"
				>
					{activeMemoryModal === 'persona'
						? $t('memory.manageStoredPersona')
						: $t('memory.manageFocus')}
				</h3>
				<p class="mt-2 text-sm font-sans leading-[1.6] text-text-secondary">
					{activeMemoryModal === 'persona'
						? $t('memory.personaModalDescription')
						: $t('memory.focusModalDescription')}
				</p>
			</div>
			<div class="flex shrink-0 items-center gap-2">
			{#if activeMemoryModal === 'persona' && selectedPersonaMemoryIds.length > 0}
				<button
					type="button"
					class="cursor-pointer rounded-full border border-danger px-3 py-1.5 text-xs font-sans font-medium text-danger transition hover:bg-danger/10 disabled:opacity-50"
					onclick={onRunBulkPersonaForget}
					disabled={isMemoryActionPending('forget-selected-persona')}
				>
					{$t('memory.forgetSelected', { count: selectedPersonaMemoryIds.length })}
				</button>
			{/if}
			{#if activeMemoryModal === 'focus' && focusContinuityView === 'tasks' && selectedTaskMemoryIds.length > 0}
				<button
					type="button"
					class="cursor-pointer rounded-full border border-danger px-3 py-1.5 text-xs font-sans font-medium text-danger transition hover:bg-danger/10 disabled:opacity-50"
					onclick={onRunBulkTaskForget}
					disabled={isMemoryActionPending('forget-selected-task')}
				>
					{$t('memory.forgetSelected', { count: selectedTaskMemoryIds.length })}
				</button>
			{/if}
			{#if activeMemoryModal === 'focus' && focusContinuityView === 'across_chats' && selectedFocusContinuityIds.length > 0}
				<button
					type="button"
					class="cursor-pointer rounded-full border border-danger px-3 py-1.5 text-xs font-sans font-medium text-danger transition hover:bg-danger/10 disabled:opacity-50"
					onclick={onRunBulkFocusContinuityForget}
					disabled={isMemoryActionPending('forget-selected-focus-continuity')}
				>
					{$t('memory.forgetSelected', { count: selectedFocusContinuityIds.length })}
				</button>
			{/if}
			{#if activeMemoryModal === 'persona' && honchoEnabled && personaMemories.length > 0}
				<button
					type="button"
					class="cursor-pointer rounded-full border border-danger px-3 py-1.5 text-xs font-sans font-medium text-danger transition hover:bg-danger/10 disabled:opacity-50"
					onclick={() =>
						onRunMemoryAction(
							{ action: 'forget_all_persona_memory' },
							'forget-all-persona',
							$t('memory.forgetAllPersonaConfirm')
							)}
					disabled={isMemoryActionPending('forget-all-persona')}
				>
					{$t('memory.forgetAll')}
				</button>
			{/if}
			<button
				type="button"
				class="btn-icon-bare h-10 w-10 cursor-pointer rounded-full text-icon-muted hover:text-text-primary"
				onclick={onClose}
				aria-label={$t('memory.closeMemoryManager')}
			>
				<X size={18} strokeWidth={2.1} aria-hidden="true" />
				</button>
			</div>
		</div>

		<div class="knowledge-memory-modal-content max-h-[calc(88vh-104px)] overflow-y-auto px-5 py-5 md:px-6">
			{#if memoryLoading && !memoryLoaded}
				<div class="rounded-[1.2rem] border border-dashed border-border bg-surface-page px-4 py-5 text-sm font-sans text-text-muted">
					{$t('memory.loading')}
				</div>
			{:else if memoryLoadError && !memoryLoaded}
				<div class="rounded-[1.2rem] border border-danger bg-surface-page px-4 py-5 text-sm font-sans text-danger">
					{memoryLoadError}
				</div>
			{:else if activeMemoryModal === 'persona'}
				{#if !honchoEnabled}
					<div class="rounded-[1.2rem] border border-dashed border-border bg-surface-page px-4 py-5 text-sm font-sans text-text-muted">
						{$t('memory.personaMemoryUnavailable')}
					</div>
				{:else if personaMemories.length === 0}
					<div class="rounded-[1.2rem] border border-dashed border-border bg-surface-page px-4 py-5 text-sm font-sans text-text-muted">
						{$t('memory.noStoredPersona')}
					</div>
				{:else}
					<div class="overflow-x-auto rounded-[1.2rem] border border-border bg-surface-page">
						<div class="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
							{#each personaMemoryFilters as state}
								<button
									type="button"
									class={`cursor-pointer rounded-full border px-3 py-1 text-[0.68rem] font-sans uppercase tracking-[0.1em] ${
										personaMemoryFilter === state
											? 'border-border bg-surface-elevated text-text-primary'
											: 'border-border text-text-muted'
									}`}
									onclick={() => onSetPersonaMemoryFilter(state)}
								>
									{state} ({personaMemoryStateCounts[state]})
								</button>
							{/each}
						</div>
						<table class="min-w-[880px] w-full border-collapse">
							<thead>
								<tr class="border-b border-border bg-surface-elevated/70 text-left">
									<th class="w-12 px-4 py-3 text-[0.68rem] font-sans uppercase tracking-[0.12em] text-text-muted">
										<input
											type="checkbox"
											checked={filteredPersonaMemories.length > 0 && selectedPersonaMemoryIds.length === filteredPersonaMemories.length}
											onchange={onToggleAllPersonaSelections}
												aria-label={$t('memory.selectAllPersona')}
											/>
										</th>
											<th class="px-4 py-3 text-[0.68rem] font-sans uppercase tracking-[0.12em] text-text-muted">{$t('memory.actor')}</th>
											<th class="px-4 py-3 text-[0.68rem] font-sans uppercase tracking-[0.12em] text-text-muted">{$t('memory.memory')}</th>
											<th class="px-4 py-3 text-[0.68rem] font-sans uppercase tracking-[0.12em] text-text-muted">{$t('memory.class')}</th>
											<th class="px-4 py-3 text-[0.68rem] font-sans uppercase tracking-[0.12em] text-text-muted">{$t('memory.source')}</th>
											<th class="px-4 py-3 text-[0.68rem] font-sans uppercase tracking-[0.12em] text-text-muted">{$t('memory.lastSeen')}</th>
											<th class="px-4 py-3 text-right text-[0.68rem] font-sans uppercase tracking-[0.12em] text-text-muted">{$t('memory.action')}</th>
								</tr>
							</thead>
							<tbody>
								{#each filteredPersonaMemories as memory, index (getPersonaRowKey(memory, index))}
									<tr class="border-b border-border last:border-b-0">
										<td class="px-4 py-3 align-top">
											<input
												type="checkbox"
												checked={selectedPersonaMemoryIds.includes(memory.id)}
												onchange={() => onTogglePersonaSelection(memory.id)}
												aria-label={`Select ${memory.canonicalText}`}
											/>
										</td>
										<td class="px-4 py-3 align-top">
											<div class="text-sm font-sans font-medium text-text-primary">
												{formatPersonaActor(memory, userDisplayName)}
											</div>
											<div class="mt-1 text-xs font-sans text-text-muted">
												{formatPersonaOrigin(memory)}
											</div>
										</td>
										<td class="px-4 py-3 align-top">
											<div class="memory-preview text-sm font-serif leading-[1.55] text-text-secondary" title={memory.canonicalText}>
												{memory.canonicalText}
											</div>
											{#if memory.members.length > 1}
													<details class="mt-2 text-xs font-sans text-text-muted">
														<summary>{$t('memory.showRaw', { count: memory.members.length })}</summary>
													<div class="mt-2 space-y-2">
														{#each memory.members as member (`${memory.id}-${member.id}`)}
															<div>
																<div>{member.content}</div>
															<div class="mt-1 text-[0.68rem] text-text-muted">
																{member.conversationTitle ?? $t('memory.conversationMemory')} · {formatMemoryTimestamp(member.createdAt)}
															</div>
															</div>
														{/each}
													</div>
												</details>
											{/if}
										</td>
										<td class="px-4 py-3 align-top text-sm font-sans text-text-secondary">
												<div>{formatPersonaClass(memory.memoryClass)}</div>
												<div class="mt-1 text-xs text-text-muted">
													{$t('memory.salienceScore', { score: memory.salienceScore })}
												</div>
										</td>
										<td class="px-4 py-3 align-top text-sm font-sans text-text-secondary">
											{formatPersonaSource(memory)}
										</td>
										<td class="px-4 py-3 align-top text-sm font-sans text-text-secondary">
											{formatMemoryTimestamp(memory.lastSeenAt)}
										</td>
										<td class="px-4 py-3 align-top text-right">
											<button
												type="button"
												class="cursor-pointer rounded-full border border-danger px-3 py-1.5 text-xs font-sans font-medium text-danger transition hover:bg-danger/10 disabled:opacity-50"
														onclick={() =>
															onRunMemoryAction(
																{ action: 'forget_persona_memory', clusterId: memory.id },
																`persona-${memory.id}`,
																$t('memory.forgetPersonaItemConfirm')
															)}
														disabled={isMemoryActionPending(`persona-${memory.id}`)}
													>
														{$t('memory.forget')}
											</button>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			{:else}
				<div class="border-b border-border px-4 py-3">
				<div class="flex flex-wrap items-center gap-2">
					<button
						type="button"
						class={`cursor-pointer rounded-full border px-3 py-1 text-[0.68rem] font-sans uppercase tracking-[0.1em] ${
							focusContinuityView === 'tasks'
								? 'border-border bg-surface-elevated text-text-primary'
								: 'border-border text-text-muted'
						}`}
						onclick={() => onSetFocusContinuityView('tasks')}
					>
						{$t('memory.tasks')} ({taskMemories.length})
					</button>
					<button
						type="button"
						class={`cursor-pointer rounded-full border px-3 py-1 text-[0.68rem] font-sans uppercase tracking-[0.1em] ${
							focusContinuityView === 'across_chats'
								? 'border-border bg-surface-elevated text-text-primary'
								: 'border-border text-text-muted'
						}`}
						onclick={() => onSetFocusContinuityView('across_chats')}
					>
						{$t('memory.acrossChats')} ({focusContinuities.length})
					</button>
				</div>
				</div>

				{#if focusContinuityView === 'tasks'}
					{#if taskMemories.length === 0}
						<div class="rounded-[1.2rem] border border-dashed border-border bg-surface-page px-4 py-5 text-sm font-sans text-text-muted">
							{$t('memory.noTaskContinuity')}
						</div>
					{:else}
						<div class="overflow-x-auto rounded-[1.2rem] border border-border bg-surface-page">
							<table class="min-w-[980px] w-full border-collapse">
								<thead>
									<tr class="border-b border-border bg-surface-elevated/70 text-left">
										<th class="w-12 px-4 py-3 text-[0.68rem] font-sans uppercase tracking-[0.12em] text-text-muted">
											<input
												type="checkbox"
												checked={taskMemories.length > 0 && selectedTaskMemoryIds.length === taskMemories.length}
												onchange={onToggleAllTaskSelections}
													aria-label={$t('memory.selectAllTask')}
													/>
												</th>
												<th class="px-4 py-3 text-[0.68rem] font-sans uppercase tracking-[0.12em] text-text-muted">{$t('memory.objective')}</th>
												<th class="px-4 py-3 text-[0.68rem] font-sans uppercase tracking-[0.12em] text-text-muted">{$t('memory.checkpoint')}</th>
												<th class="px-4 py-3 text-[0.68rem] font-sans uppercase tracking-[0.12em] text-text-muted">{$t('memory.conversation')}</th>
												<th class="px-4 py-3 text-[0.68rem] font-sans uppercase tracking-[0.12em] text-text-muted">{$t('memory.status')}</th>
												<th class="px-4 py-3 text-[0.68rem] font-sans uppercase tracking-[0.12em] text-text-muted">{$t('memory.updated')}</th>
												<th class="px-4 py-3 text-right text-[0.68rem] font-sans uppercase tracking-[0.12em] text-text-muted">{$t('memory.action')}</th>
									</tr>
								</thead>
								<tbody>
									{#each taskMemories as memory (memory.taskId)}
										<tr class="border-b border-border last:border-b-0">
											<td class="px-4 py-3 align-top">
												<input
													type="checkbox"
													checked={selectedTaskMemoryIds.includes(memory.taskId)}
													onchange={() => onToggleTaskSelection(memory.taskId)}
													aria-label={`Select ${memory.objective}`}
												/>
											</td>
											<td class="px-4 py-3 align-top">
												<div class="text-sm font-sans font-medium text-text-primary">
													{memory.objective}
												</div>
											</td>
											<td class="px-4 py-3 align-top">
														<div class="memory-preview text-sm font-serif leading-[1.55] text-text-secondary" title={memory.checkpointSummary ?? ''}>
															{memory.checkpointSummary ?? $t('memory.noCheckpointSummary')}
														</div>
											</td>
														<td class="px-4 py-3 align-top text-sm font-sans text-text-secondary">
															{memory.conversationTitle ?? $t('memory.conversationMemory')}
														</td>
											<td class="px-4 py-3 align-top">
												<div class="flex flex-wrap gap-2">
													<span class="rounded-full border border-border px-2.5 py-1 text-[0.68rem] font-sans uppercase tracking-[0.1em] text-text-muted">
														{memory.status}
													</span>
															{#if memory.locked}
																<span class="rounded-full border border-border px-2.5 py-1 text-[0.68rem] font-sans uppercase tracking-[0.1em] text-text-muted">
																	{$t('memory.locked')}
																</span>
															{/if}
												</div>
											</td>
											<td class="px-4 py-3 align-top text-sm font-sans text-text-secondary">
												{formatMemoryTimestamp(memory.updatedAt)}
											</td>
										<td class="px-4 py-3 align-top text-right">
											<button
												type="button"
												class="cursor-pointer rounded-full border border-danger px-3 py-1.5 text-xs font-sans font-medium text-danger transition hover:bg-danger/10 disabled:opacity-50"
																onclick={() =>
																	onRunMemoryAction(
																		{ action: 'forget_task_memory', taskId: memory.taskId },
																		`task-${memory.taskId}`,
																		$t('memory.forgetTaskItemConfirm')
																	)}
																disabled={isMemoryActionPending(`task-${memory.taskId}`)}
															>
																{$t('memory.forget')}
											</button>
										</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					{/if}
				{:else if focusContinuities.length === 0}
					<div class="rounded-[1.2rem] border border-dashed border-border bg-surface-page px-4 py-5 text-sm font-sans text-text-muted">
						{$t('memory.noAcrossChatContinuity')}
					</div>
				{:else}
					<div class="overflow-x-auto rounded-[1.2rem] border border-border bg-surface-page">
						<table class="min-w-[980px] w-full border-collapse">
							<thead>
								<tr class="border-b border-border bg-surface-elevated/70 text-left">
									<th class="w-12 px-4 py-3 text-[0.68rem] font-sans uppercase tracking-[0.12em] text-text-muted">
										<input
											type="checkbox"
											checked={focusContinuities.length > 0 && selectedFocusContinuityIds.length === focusContinuities.length}
											onchange={onToggleAllFocusContinuitySelections}
													aria-label={$t('memory.selectAllAcrossChat')}
													/>
												</th>
												<th class="px-4 py-3 text-[0.68rem] font-sans uppercase tracking-[0.12em] text-text-muted">{$t('memory.continuity')}</th>
												<th class="px-4 py-3 text-[0.68rem] font-sans uppercase tracking-[0.12em] text-text-muted">{$t('memory.summary')}</th>
												<th class="px-4 py-3 text-[0.68rem] font-sans uppercase tracking-[0.12em] text-text-muted">{$t('memory.status')}</th>
												<th class="px-4 py-3 text-[0.68rem] font-sans uppercase tracking-[0.12em] text-text-muted">{$t('memory.linkedChats')}</th>
												<th class="px-4 py-3 text-[0.68rem] font-sans uppercase tracking-[0.12em] text-text-muted">{$t('memory.updated')}</th>
												<th class="px-4 py-3 text-right text-[0.68rem] font-sans uppercase tracking-[0.12em] text-text-muted">{$t('memory.action')}</th>
								</tr>
							</thead>
							<tbody>
								{#each focusContinuities as memory (memory.continuityId)}
									<tr class="border-b border-border last:border-b-0">
										<td class="px-4 py-3 align-top">
											<input
												type="checkbox"
												checked={selectedFocusContinuityIds.includes(memory.continuityId)}
												onchange={() => onToggleFocusContinuitySelection(memory.continuityId)}
												aria-label={`Select ${memory.name}`}
											/>
										</td>
										<td class="px-4 py-3 align-top">
											<div class="text-sm font-sans font-medium text-text-primary">
												{memory.name}
											</div>
														<div class="mt-1 text-xs font-sans text-text-muted">
															{memory.linkedTaskCount} {$t('memory.linkedTask')}{memory.linkedTaskCount === 1 ? '' : 's'}
														</div>
										</td>
										<td class="px-4 py-3 align-top">
														<div class="memory-preview text-sm font-serif leading-[1.55] text-text-secondary" title={memory.summary ?? ''}>
															{memory.summary ?? $t('memory.noContinuitySummary')}
														</div>
										</td>
										<td class="px-4 py-3 align-top">
											<span class="rounded-full border border-border px-2.5 py-1 text-[0.68rem] font-sans uppercase tracking-[0.1em] text-text-muted">
												{memory.status}
											</span>
										</td>
														<td class="px-4 py-3 align-top text-sm font-sans text-text-secondary">
															{memory.conversationTitles.length > 0
																? memory.conversationTitles.join(', ')
																: $t('memory.conversationMemory')}
														</td>
										<td class="px-4 py-3 align-top text-sm font-sans text-text-secondary">
											{formatMemoryTimestamp(memory.updatedAt)}
										</td>
										<td class="px-4 py-3 align-top text-right">
											<button
												type="button"
												class="cursor-pointer rounded-full border border-danger px-3 py-1.5 text-xs font-sans font-medium text-danger transition hover:bg-danger/10 disabled:opacity-50"
																onclick={() =>
																	onRunMemoryAction(
																		{ action: 'forget_focus_continuity', continuityId: memory.continuityId },
																		`focus-continuity-${memory.continuityId}`,
																		$t('memory.forgetFocusItemConfirm')
																	)}
																disabled={isMemoryActionPending(`focus-continuity-${memory.continuityId}`)}
															>
																{$t('memory.forget')}
											</button>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			{/if}
		</div>
	</div>
</div>

<style>
	.knowledge-memory-modal-content :global(table thead) {
		position: sticky;
		top: 0;
		z-index: 10;
		background: var(--surface-elevated);
	}

	.knowledge-memory-modal-content :global(tbody tr) {
		transition: background-color var(--duration-standard) var(--ease-out);
	}

	.knowledge-memory-modal-content :global(tbody tr:hover) {
		background: var(--surface-elevated);
	}

	.knowledge-memory-modal-content :global(input[type='checkbox']) {
		appearance: none;
		width: 18px;
		height: 18px;
		border: 1.5px solid var(--border-default);
		border-radius: var(--radius-sm);
		background: var(--surface-elevated);
		cursor: pointer;
		position: relative;
		transition: all var(--duration-standard) var(--ease-out);
	}

	.knowledge-memory-modal-content :global(input[type='checkbox']:hover) {
		border-color: var(--accent);
	}

	.knowledge-memory-modal-content :global(input[type='checkbox']:checked) {
		background: var(--accent);
		border-color: var(--accent);
	}

	.knowledge-memory-modal-content :global(input[type='checkbox']:checked::after) {
		content: '';
		position: absolute;
		left: 5px;
		top: 2px;
		width: 5px;
		height: 9px;
		border: solid white;
		border-width: 0 2px 2px 0;
		transform: rotate(45deg);
	}
</style>
