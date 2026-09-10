<script lang="ts">
// Every model choice in the product, on one page and in one control idiom.
// Atlas gets a real per-task table — ask, researcher, outline, writer, critic,
// verifier — instead of two selects named after pipeline internals.
import { Info } from "@lucide/svelte";
import { t, type I18nKey } from "$lib/i18n";
import ModelSelect from "./ModelSelect.svelte";
import SettingRow from "./SettingRow.svelte";
import SystemCard from "./SystemCard.svelte";
import SystemTabs from "./SystemTabs.svelte";
import SystemToggle from "./SystemToggle.svelte";
import ValueField from "./ValueField.svelte";
import {
	type ModelOptionGroup,
	flattenModelOptions,
	resolveModelValue,
} from "./model-options";
import "./system.css";

let {
	adminConfig,
	envDefaults = {},
	modelGroups,
	failoverModelGroups,
	highlightKey = "",
	isDirty,
	setValue,
	resetValue,
}: {
	adminConfig: Record<string, string>;
	envDefaults?: Record<string, string>;
	modelGroups: ModelOptionGroup[];
	failoverModelGroups: ModelOptionGroup[];
	highlightKey?: string;
	isDirty: (key: string) => boolean;
	setValue: (key: string, value: string) => void;
	resetValue: (key: string) => void;
} = $props();

let atlasTab = $state("models");

const ATLAS_TASKS = [
	{ task: "ask", key: "ATLAS_V3_ASK_MODEL", inherits: "audit" },
	{
		task: "researcher",
		key: "ATLAS_V3_RESEARCHER_MODEL",
		inherits: "synthesis",
	},
	{ task: "outline", key: "ATLAS_V3_OUTLINE_MODEL", inherits: "audit" },
	{ task: "writer", key: "ATLAS_V3_WRITER_MODEL", inherits: "synthesis" },
	{ task: "critic", key: "ATLAS_V3_CRITIC_MODEL", inherits: "audit" },
	{ task: "verifier", key: "ATLAS_V3_VERIFIER_MODEL", inherits: "audit" },
] as const;

const DEPTH_ROWS = [
	{ key: "ATLAS_V3_CRITIC_ROUNDS", min: 0, max: 3, unit: "" },
	{ key: "ATLAS_V3_RESEARCHER_CONCURRENCY", min: 1, max: 8, unit: "" },
	{ key: "ATLAS_V3_SEARCHES_PER_STEP", min: 3, max: 5, unit: "" },
	{ key: "ATLAS_V3_PAGES_PER_QUESTION_OVERVIEW", min: 0, max: 6, unit: "" },
	{ key: "ATLAS_V3_PAGES_PER_QUESTION_IN_DEPTH", min: 0, max: 6, unit: "" },
	{ key: "ATLAS_V3_PAGES_PER_QUESTION_EXHAUSTIVE", min: 0, max: 6, unit: "" },
] as const;

const WORKER_ROWS = [
	{
		key: "ATLAS_GLOBAL_ACTIVE_LIMIT",
		label: "admin.atlasGlobalActiveLimit",
		min: 1,
	},
	{
		key: "ATLAS_SEARCH_CONCURRENCY",
		label: "admin.atlasSearchConcurrency",
		min: 1,
	},
	{
		key: "ATLAS_SEARCH_BATCH_DELAY_MS",
		label: "admin.atlasSearchBatchDelayMs",
		min: 0,
	},
] as const;

const PIPELINES = ["v1", "v2", "v3"] as const;

let titleLang = $state<"en" | "hu">("en");

const atlasModelValue = (key: string) =>
	resolveModelValue(
		modelGroups,
		adminConfig[key] || envDefaults[key],
		"model1",
	);

const inheritedLabel = (inherits: "synthesis" | "audit") => {
	const key =
		inherits === "synthesis" ? "ATLAS_SYNTHESIS_MODEL" : "ATLAS_AUDIT_MODEL";
	const id = adminConfig[key] || envDefaults[key] || "model1";
	const option = flattenModelOptions(modelGroups).find(
		(entry) => entry.id === id,
	);
	return $t("admin.system.atlas.inherit", { model: option?.label ?? id });
};

const huComplete = $derived(
	Boolean(
		(adminConfig.TITLE_GEN_SYSTEM_PROMPT_HU ?? "").trim() &&
			(adminConfig.TITLE_GEN_SYSTEM_PROMPT_CODE_APPENDIX_HU ?? "").trim(),
	),
);

const systemPromptLength = $derived((adminConfig.SYSTEM_PROMPT ?? "").length);
</script>

<div class="sys-stack" data-testid="system-page-ai-tasks">
	<SystemCard
		title={$t('admin.system.atlas.title')}
		description={$t('admin.system.atlas.description')}
		testId="system-atlas-card"
	>
		{#snippet actions()}
			<span class="sys-row-control">
				<SystemToggle
					id="ATLAS_WORKER_ENABLED"
					label={$t('admin.atlasWorkerEnabled')}
					checked={adminConfig.ATLAS_WORKER_ENABLED !== 'false'}
					onchange={(next) => setValue('ATLAS_WORKER_ENABLED', next ? 'true' : 'false')}
				/>
				<span class="sys-xs sys-muted">{$t('admin.system.atlas.workerEnabled')}</span>
				{#if isDirty('ATLAS_WORKER_ENABLED')}
					<span class="sys-chip sys-chip-dirty">{$t('admin.system.unsaved')}</span>
				{/if}
			</span>
		{/snippet}

		<SystemTabs
			bind:active={atlasTab}
			label={$t('admin.system.atlas.title')}
			tabs={[
				{ id: 'models', label: $t('admin.system.atlas.tabs.models') },
				{ id: 'worker', label: $t('admin.system.atlas.tabs.worker') },
				{ id: 'depth', label: $t('admin.system.atlas.tabs.depth') },
				{ id: 'pipeline', label: $t('admin.system.atlas.tabs.prompts') },
			]}
		/>

		{#if atlasTab === 'models'}
			<div id="sys-tabpanel-models" role="tabpanel" aria-labelledby="sys-tab-models">
				<div class="sys-table-scroll">
					<table class="sys-table">
						<thead>
							<tr>
								<th>{$t('admin.system.atlas.taskColumn')}</th>
								<th>{$t('admin.system.atlas.modelColumn')}</th>
							</tr>
						</thead>
						<tbody>
							{#each ATLAS_TASKS as row (row.key)}
								<tr
									class:sys-tr-dirty={isDirty(row.key)}
									class:sys-tr-highlight={highlightKey === row.key}
									data-config-key={row.key}
								>
									<td class="sys-td-primary" style="width: 320px">
										<span class="sys-label">
											<label for={row.key}>
												{$t(`admin.system.atlas.tasks.${row.task}.label` as I18nKey)}
											</label>
											{#if isDirty(row.key)}
												<span class="sys-chip sys-chip-dirty">{$t('admin.system.unsaved')}</span>
											{/if}
										</span>
										<p class="sys-help">
											{$t(`admin.system.atlas.tasks.${row.task}.meaning` as I18nKey)}
										</p>
										<span class="sys-key">{row.key}</span>
									</td>
									<td>
										<ModelSelect
											id={row.key}
											groups={modelGroups}
											value={adminConfig[row.key] ?? ''}
											inheritLabel={inheritedLabel(row.inherits)}
											onchange={(next) => setValue(row.key, next)}
										/>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<div class="sys-banner" style="margin-top: 14px">
					<span class="sys-banner-icon">
						<Info size={14} strokeWidth={2} aria-hidden="true" />
					</span>
					<span>
						{$t('admin.system.atlas.inheritNote')}
						{$t('admin.system.atlas.v3Only')}
					</span>
				</div>
			</div>
		{:else if atlasTab === 'worker'}
			<div id="sys-tabpanel-worker" role="tabpanel" aria-labelledby="sys-tab-worker" class="sys-rows">
				<SettingRow
					label={$t('admin.atlasSynthesisModel')}
					meaning={$t('admin.atlasSynthesisModelDescription')}
					configKey="ATLAS_SYNTHESIS_MODEL"
					controlId="ATLAS_SYNTHESIS_MODEL"
					dirty={isDirty('ATLAS_SYNTHESIS_MODEL')}
					highlighted={highlightKey === 'ATLAS_SYNTHESIS_MODEL'}
					onReset={() => resetValue('ATLAS_SYNTHESIS_MODEL')}
					canReset={isDirty('ATLAS_SYNTHESIS_MODEL')}
				>
					{#snippet control()}
						<ModelSelect
							id="ATLAS_SYNTHESIS_MODEL"
							groups={modelGroups}
							value={atlasModelValue('ATLAS_SYNTHESIS_MODEL')}
							onchange={(next) => setValue('ATLAS_SYNTHESIS_MODEL', next)}
						/>
					{/snippet}
				</SettingRow>

				<SettingRow
					label={$t('admin.atlasAuditModel')}
					meaning={$t('admin.atlasAuditModelDescription')}
					configKey="ATLAS_AUDIT_MODEL"
					controlId="ATLAS_AUDIT_MODEL"
					dirty={isDirty('ATLAS_AUDIT_MODEL')}
					highlighted={highlightKey === 'ATLAS_AUDIT_MODEL'}
					onReset={() => resetValue('ATLAS_AUDIT_MODEL')}
					canReset={isDirty('ATLAS_AUDIT_MODEL')}
				>
					{#snippet control()}
						<ModelSelect
							id="ATLAS_AUDIT_MODEL"
							groups={modelGroups}
							value={atlasModelValue('ATLAS_AUDIT_MODEL')}
							onchange={(next) => setValue('ATLAS_AUDIT_MODEL', next)}
						/>
					{/snippet}
				</SettingRow>

				{#each WORKER_ROWS as row (row.key)}
					<SettingRow
						label={$t(row.label)}
						configKey={row.key}
						controlId={row.key}
						dirty={isDirty(row.key)}
						highlighted={highlightKey === row.key}
						onReset={() => resetValue(row.key)}
						canReset={isDirty(row.key)}
					>
						{#snippet control()}
							<ValueField
								id={row.key}
								type="number"
								size="sm"
								min={row.min}
								value={adminConfig[row.key] ?? ''}
								placeholder={envDefaults[row.key] ?? ''}
								onchange={(next) => setValue(row.key, next)}
							/>
						{/snippet}
					</SettingRow>
				{/each}

				<p class="sys-help">{$t('admin.atlasLimitsDescription')}</p>
				<p class="sys-help">{$t('admin.atlasParallelDependency')}</p>
			</div>
		{:else if atlasTab === 'depth'}
			<div id="sys-tabpanel-depth" role="tabpanel" aria-labelledby="sys-tab-depth" class="sys-rows">
				{#each DEPTH_ROWS as row (row.key)}
					<SettingRow
						label={$t(`admin.system.keys.${row.key}.label` as I18nKey)}
						meaning={$t(`admin.system.keys.${row.key}.meaning` as I18nKey)}
						configKey={row.key}
						controlId={row.key}
						dirty={isDirty(row.key)}
						highlighted={highlightKey === row.key}
						onReset={() => resetValue(row.key)}
						canReset={isDirty(row.key)}
					>
						{#snippet control()}
							<ValueField
								id={row.key}
								type="number"
								size="sm"
								min={row.min}
								max={row.max}
								value={adminConfig[row.key] ?? ''}
								placeholder={envDefaults[row.key] ?? ''}
								onchange={(next) => setValue(row.key, next)}
							/>
						{/snippet}
					</SettingRow>
				{/each}

				<SettingRow
					label={$t('admin.system.keys.ATLAS_V3_LANGUAGE_STANDARD_HU.label')}
					meaning={$t('admin.system.keys.ATLAS_V3_LANGUAGE_STANDARD_HU.meaning')}
					configKey="ATLAS_V3_LANGUAGE_STANDARD_HU"
					dirty={isDirty('ATLAS_V3_LANGUAGE_STANDARD_HU')}
					highlighted={highlightKey === 'ATLAS_V3_LANGUAGE_STANDARD_HU'}
					onReset={() => resetValue('ATLAS_V3_LANGUAGE_STANDARD_HU')}
					canReset={isDirty('ATLAS_V3_LANGUAGE_STANDARD_HU')}
				>
					{#snippet control()}
						<SystemToggle
							id="ATLAS_V3_LANGUAGE_STANDARD_HU"
							label={$t('admin.system.keys.ATLAS_V3_LANGUAGE_STANDARD_HU.label')}
							checked={adminConfig.ATLAS_V3_LANGUAGE_STANDARD_HU !== 'false'}
							onchange={(next) =>
								setValue('ATLAS_V3_LANGUAGE_STANDARD_HU', next ? 'true' : 'false')}
						/>
					{/snippet}
				</SettingRow>
			</div>
		{:else}
			<div id="sys-tabpanel-pipeline" role="tabpanel" aria-labelledby="sys-tab-pipeline" class="sys-rows">
				<SettingRow
					label={$t('admin.system.atlas.pipeline.label')}
					meaning={$t('admin.system.atlas.pipeline.meaning')}
					configKey="ATLAS_PIPELINE"
					dirty={isDirty('ATLAS_PIPELINE')}
					highlighted={highlightKey === 'ATLAS_PIPELINE'}
					onReset={() => resetValue('ATLAS_PIPELINE')}
					canReset={isDirty('ATLAS_PIPELINE')}
				>
					{#snippet control()}
						<span class="sys-row-control" role="radiogroup" aria-label={$t('admin.system.atlas.pipeline.label')}>
							{#each PIPELINES as pipeline (pipeline)}
								{@const current =
									(adminConfig.ATLAS_PIPELINE || envDefaults.ATLAS_PIPELINE || 'v1') === pipeline}
								<button
									type="button"
									role="radio"
									aria-checked={current}
									class="sys-mini"
									class:sys-mini-on={current}
									data-testid={`atlas-pipeline-${pipeline}`}
									onclick={() => setValue('ATLAS_PIPELINE', pipeline)}
								>
									{pipeline}
								</button>
							{/each}
						</span>
					{/snippet}
				</SettingRow>
			</div>
		{/if}
	</SystemCard>

	<SystemCard
		title={$t('admin.system.memory.title')}
		description={$t('admin.system.memory.description')}
	>
		<div class="sys-rows">
			<SettingRow
				label={$t('admin.memoryJudgeModel')}
				meaning={$t('admin.memoryJudgeModelDescription')}
				configKey="MEMORY_JUDGE_MODEL"
				controlId="MEMORY_JUDGE_MODEL"
				dirty={isDirty('MEMORY_JUDGE_MODEL')}
				highlighted={highlightKey === 'MEMORY_JUDGE_MODEL'}
				onReset={() => resetValue('MEMORY_JUDGE_MODEL')}
				canReset={isDirty('MEMORY_JUDGE_MODEL')}
			>
				{#snippet control()}
					<ModelSelect
						id="MEMORY_JUDGE_MODEL"
						groups={failoverModelGroups}
						value={resolveModelValue(failoverModelGroups, adminConfig.MEMORY_JUDGE_MODEL)}
						onchange={(next) => setValue('MEMORY_JUDGE_MODEL', next)}
					/>
				{/snippet}
			</SettingRow>

			<SettingRow
				label={$t('admin.memoryConsolidationModel')}
				meaning={$t('admin.memoryConsolidationModelDescription')}
				configKey="MEMORY_CONSOLIDATION_MODEL"
				controlId="MEMORY_CONSOLIDATION_MODEL"
				dirty={isDirty('MEMORY_CONSOLIDATION_MODEL')}
				highlighted={highlightKey === 'MEMORY_CONSOLIDATION_MODEL'}
				onReset={() => resetValue('MEMORY_CONSOLIDATION_MODEL')}
				canReset={isDirty('MEMORY_CONSOLIDATION_MODEL')}
			>
				{#snippet control()}
					<ModelSelect
						id="MEMORY_CONSOLIDATION_MODEL"
						groups={failoverModelGroups}
						value={resolveModelValue(
							failoverModelGroups,
							adminConfig.MEMORY_CONSOLIDATION_MODEL,
						)}
						onchange={(next) => setValue('MEMORY_CONSOLIDATION_MODEL', next)}
					/>
				{/snippet}
			</SettingRow>
		</div>
	</SystemCard>

	<SystemCard
		title={$t('admin.system.titles.title')}
		description={$t('admin.system.titles.description')}
	>
		<div class="sys-rows">
			<SettingRow
				label={$t('admin.titleGenModel')}
				configKey="TITLE_GEN_MODEL"
				controlId="TITLE_GEN_MODEL"
				dirty={isDirty('TITLE_GEN_MODEL')}
				highlighted={highlightKey === 'TITLE_GEN_MODEL'}
				onReset={() => resetValue('TITLE_GEN_MODEL')}
				canReset={isDirty('TITLE_GEN_MODEL')}
			>
				{#snippet control()}
					<ModelSelect
						id="TITLE_GEN_MODEL"
						groups={modelGroups}
						value={adminConfig.TITLE_GEN_MODEL ?? ''}
						onchange={(next) => setValue('TITLE_GEN_MODEL', next)}
					/>
				{/snippet}
			</SettingRow>
		</div>

		<hr class="sys-hr" />

		<div class="sys-row-control" style="justify-content: space-between">
			<span class="sys-eyebrow">{$t('admin.system.titles.promptSection')}</span>
			<span class="sys-row-control">
				<button
					type="button"
					class="sys-mini"
					class:sys-mini-on={titleLang === 'en'}
					aria-pressed={titleLang === 'en'}
					onclick={() => (titleLang = 'en')}
				>
					{$t('admin.system.titles.langEn')}
				</button>
				<button
					type="button"
					class="sys-mini"
					class:sys-mini-on={titleLang === 'hu'}
					aria-pressed={titleLang === 'hu'}
					onclick={() => (titleLang = 'hu')}
				>
					{$t('admin.system.titles.langHu')}
					<span class="sys-pill" class:sys-pill-ok={huComplete} class:sys-pill-muted={!huComplete}>
						{huComplete
							? $t('admin.system.titles.complete')
							: $t('admin.system.titles.incomplete')}
					</span>
				</button>
			</span>
		</div>

		<div class="sys-grid2" style="margin-top: 10px">
			{#each [{ base: 'TITLE_GEN_SYSTEM_PROMPT', label: 'admin.system.titles.basePrompt', help: 'admin.basePromptDescription' }, { base: 'TITLE_GEN_SYSTEM_PROMPT_CODE_APPENDIX', label: 'admin.system.titles.appendix', help: 'admin.codeAppendixDescription' }] as field (field.base)}
				{@const key = `${field.base}_${titleLang.toUpperCase()}`}
				<div data-config-key={key} class:sys-row-highlight={highlightKey === key}>
					<span class="sys-label">
						<label for={key}>{$t(field.label as I18nKey)}</label>
						{#if isDirty(key)}
							<span class="sys-chip sys-chip-dirty">{$t('admin.system.unsaved')}</span>
						{/if}
					</span>
					<ValueField
						id={key}
						type="textarea"
						rows={5}
						value={adminConfig[key] ?? ''}
						onchange={(next) => setValue(key, next)}
					/>
					<p class="sys-help">{$t(field.help as I18nKey)}</p>
					<span class="sys-key">{key}</span>
				</div>
			{/each}
		</div>
	</SystemCard>

	<SystemCard
		title={$t('admin.system.summarizer.title')}
		description={$t('admin.system.summarizer.description')}
	>
		<div class="sys-rows">
			<SettingRow
				label={$t('admin.contextSummarizerModel')}
				meaning={$t('admin.summarizerModelDescription')}
				configKey="CONTEXT_SUMMARIZER_MODEL"
				controlId="CONTEXT_SUMMARIZER_MODEL"
				dirty={isDirty('CONTEXT_SUMMARIZER_MODEL')}
				highlighted={highlightKey === 'CONTEXT_SUMMARIZER_MODEL'}
				onReset={() => resetValue('CONTEXT_SUMMARIZER_MODEL')}
				canReset={isDirty('CONTEXT_SUMMARIZER_MODEL')}
			>
				{#snippet control()}
					<ModelSelect
						id="CONTEXT_SUMMARIZER_MODEL"
						groups={modelGroups}
						value={adminConfig.CONTEXT_SUMMARIZER_MODEL ?? ''}
						onchange={(next) => setValue('CONTEXT_SUMMARIZER_MODEL', next)}
					/>
				{/snippet}
			</SettingRow>
		</div>
	</SystemCard>

	<SystemCard
		title={$t('admin.system.systemPrompt.title')}
		description={$t('admin.system.systemPrompt.description')}
	>
		<div
			data-config-key="SYSTEM_PROMPT"
			class:sys-row-highlight={highlightKey === 'SYSTEM_PROMPT'}
		>
			<span class="sys-label">
				<label for="SYSTEM_PROMPT">{$t('admin.systemPromptLabel')}</label>
				{#if isDirty('SYSTEM_PROMPT')}
					<span class="sys-chip sys-chip-dirty">{$t('admin.system.unsaved')}</span>
				{/if}
			</span>
			<ValueField
				id="SYSTEM_PROMPT"
				type="textarea"
				rows={10}
				value={adminConfig.SYSTEM_PROMPT ?? ''}
				placeholder={envDefaults.SYSTEM_PROMPT ?? ''}
				onchange={(next) => setValue('SYSTEM_PROMPT', next)}
			/>
			<div class="sys-row-control" style="justify-content: space-between; margin-top: 6px">
				<span class="sys-key">SYSTEM_PROMPT</span>
				<span class="sys-count">
					{$t('admin.system.charCount', {
						count: String(systemPromptLength),
						max: '20000',
					})}
				</span>
			</div>
			<p class="sys-help">{$t('admin.systemPromptDescription')}</p>
		</div>
	</SystemCard>
</div>
