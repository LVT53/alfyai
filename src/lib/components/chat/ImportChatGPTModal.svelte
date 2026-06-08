<script lang="ts">
import { tick } from "svelte";
import JSZip from "jszip";
import { t } from "$lib/i18n";
import { Upload, Check, AlertCircle } from "@lucide/svelte";
import type { Project } from "$lib/types";
import DialogShell from "$lib/components/ui/DialogShell.svelte";
import { importChatGPTData } from "$lib/client/api/chatgpt-import";

interface ChatGPTConversation {
	title: string;
	create_time: number;
	update_time: number;
	mapping: Record<
		string,
		{ message?: unknown | null; parent?: string | null; children?: string[] }
	>;
}

interface ParsedChat {
	title: string;
	createTime: number;
	messageCount: number;
	selected: boolean;
}

let {
	show = $bindable(false),
	onClose = () => {},
	projects = [] as Project[],
}: {
	show: boolean;
	onClose?: () => void;
	projects?: Project[];
} = $props();

let state = $state<
	"upload" | "preview" | "config" | "importing" | "complete" | "error"
>("upload");
let file = $state<File | null>(null);
let parsedChats = $state<ParsedChat[]>([]);
let filteredChats = $state<ParsedChat[]>([]);
let searchQuery = $state("");
let selectedProjectId = $state<string | null>(null);
let importProgress = $state({ current: 0, total: 0 });
let importResult = $state<{
	conversationIds: string[];
	errors: { conversationTitle?: string; reason: string }[];
} | null>(null);
let errorMessage = $state("");
let isDragging = $state(false);
let fileInputRef = $state<HTMLInputElement | undefined>(undefined);

$effect(() => {
	if (!show) {
		// Reset state when modal closes
		tick().then(() => {
			state = "upload";
			file = null;
			parsedChats = [];
			filteredChats = [];
			searchQuery = "";
			selectedProjectId = null;
			importProgress = { current: 0, total: 0 };
			importResult = null;
			errorMessage = "";
			isDragging = false;
		});
	}
});

$effect(() => {
	const query = searchQuery.trim().toLowerCase();
	if (!query) {
		filteredChats = parsedChats;
	} else {
		filteredChats = parsedChats.filter((chat) =>
			chat.title.toLowerCase().includes(query),
		);
	}
});

const allSelected = $derived(
	filteredChats.length > 0 && filteredChats.every((chat) => chat.selected),
);

const someSelected = $derived(filteredChats.some((chat) => chat.selected));

const selectedCount = $derived(
	parsedChats.filter((chat) => chat.selected).length,
);

function countMessages(mapping: ChatGPTConversation["mapping"]): number {
	let count = 0;
	for (const node of Object.values(mapping)) {
		if (node?.message != null) {
			count += 1;
		}
	}
	return count;
}

async function parseZip(uploadedFile: File): Promise<void> {
	try {
		const zip = await JSZip.loadAsync(uploadedFile);
		const jsonFile = zip.file("conversations.json");
		if (!jsonFile) {
			throw new Error($t("chatgptImport.parseError"));
		}
		const text = await jsonFile.async("text");
		const data = JSON.parse(text) as ChatGPTConversation[];

		if (!Array.isArray(data) || data.length === 0) {
			throw new Error($t("chatgptImport.noConversations"));
		}

		parsedChats = data.map((conv) => ({
			title: conv.title || "Untitled",
			createTime: conv.create_time,
			messageCount: countMessages(conv.mapping),
			selected: true,
		}));
		filteredChats = parsedChats;
		state = "preview";
	} catch (err) {
		errorMessage =
			err instanceof Error ? err.message : $t("chatgptImport.parseError");
		state = "error";
	}
}

function handleFileSelect(uploadedFile: File): void {
	if (!uploadedFile.name.toLowerCase().endsWith(".zip")) {
		errorMessage = $t("chatgptImport.invalidFile");
		state = "error";
		return;
	}
	file = uploadedFile;
	void parseZip(uploadedFile);
}

function handleDrop(event: DragEvent): void {
	event.preventDefault();
	isDragging = false;
	const droppedFile = event.dataTransfer?.files[0];
	if (droppedFile) {
		handleFileSelect(droppedFile);
	}
}

function handleDragOver(event: DragEvent): void {
	event.preventDefault();
	isDragging = true;
}

function handleDragLeave(): void {
	isDragging = false;
}

function handleInputChange(event: Event): void {
	const target = event.target as HTMLInputElement;
	const selectedFile = target.files?.[0];
	if (selectedFile) {
		handleFileSelect(selectedFile);
	}
}

function toggleSelectAll(): void {
	const newValue = !allSelected;
	for (const chat of filteredChats) {
		chat.selected = newValue;
	}
	// Also update the underlying parsedChats for filtered-out items
	for (const chat of parsedChats) {
		if (!filteredChats.includes(chat)) {
			chat.selected = newValue;
		}
	}
}

function toggleChat(index: number): void {
	const chat = filteredChats[index];
	if (chat) {
		chat.selected = !chat.selected;
	}
}

function goToConfig(): void {
	if (selectedCount === 0) return;
	state = "config";
}

function goBackToPreview(): void {
	state = "preview";
}

async function startImport(): Promise<void> {
	if (!file || selectedCount === 0) return;
	state = "importing";
	importProgress = { current: 0, total: selectedCount };

	try {
		const result = await importChatGPTData(file, selectedProjectId);
		importResult = {
			conversationIds: result.conversationIds,
			errors: result.errors,
		};
		importProgress = { current: selectedCount, total: selectedCount };
		state = "complete";
	} catch (err) {
		errorMessage =
			err instanceof Error ? err.message : $t("chatgptImport.importError");
		state = "error";
	}
}

function formatDate(timestamp: number): string {
	if (!timestamp) return "";
	try {
		return new Date(timestamp * 1000).toLocaleDateString();
	} catch {
		return "";
	}
}

function handleClose(): void {
	onClose();
}

function handleRetry(): void {
	errorMessage = "";
	state = "upload";
}
</script>

{#if show}
	<DialogShell
		title={state === "upload"
			? $t("chatgptImport.title")
			: state === "preview"
				? $t("chatgptImport.previewTitle")
				: state === "config"
					? $t("chatgptImport.configTitle")
					: state === "importing"
						? $t("chatgptImport.importingTitle")
						: state === "complete"
							? $t("chatgptImport.importComplete")
							: $t("chatgptImport.importError")}
		description={state === "upload" ? $t("chatgptImport.description") : undefined}
		onClose={handleClose}
		maxWidthClass={state === "preview" || state === "config" ? "max-w-[640px]" : "max-w-[480px]"}
		zIndexClass="z-50"
	>
		<div class="flex flex-col gap-4">
			{#if state === "upload"}
				<div
					role="button"
					tabindex="0"
					aria-label={$t("chatgptImport.dropHere")}
					class="flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-8 transition-colors"
					class:border-accent={isDragging}
					class:border-border-default={!isDragging}
					class:bg-surface-elevated={isDragging}
					ondrop={handleDrop}
					ondragover={handleDragOver}
					ondragleave={handleDragLeave}
					onclick={() => fileInputRef?.click()}
					onkeydown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							fileInputRef?.click();
						}
					}}
				>
					<Upload class="h-10 w-10 text-icon-muted" size={40} strokeWidth={1.5} aria-hidden="true" />
					<p class="text-center text-sm text-text-muted">
						{$t("chatgptImport.uploadPrompt")}
					</p>
					<button type="button" class="btn-primary mt-2">
						{$t("chatgptImport.selectFile")}
					</button>
				</div>
				<input
					bind:this={fileInputRef}
					type="file"
					accept=".zip"
					class="hidden"
					onchange={handleInputChange}
				/>
			{:else if state === "preview"}
				<div class="flex flex-col gap-3">
					<div class="flex items-center gap-2">
						<input
							type="text"
							placeholder={$t("chatgptImport.searchPlaceholder")}
							bind:value={searchQuery}
							class="flex-1 rounded-md border border-border-default bg-surface-page px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-border-focus focus:outline-none"
						/>
						<button
							type="button"
							class="btn-secondary whitespace-nowrap text-sm"
							onclick={toggleSelectAll}
						>
							{allSelected ? $t("chatgptImport.deselectAll") : $t("chatgptImport.selectAll")}
						</button>
					</div>

					<p class="text-xs text-text-muted">
						{$t("chatgptImport.chatsFound", { count: filteredChats.length })}
						{#if selectedCount > 0}
							<span class="ml-1">· {selectedCount} {$t("chatgptImport.messages", { count: selectedCount }).replace(/\d+\s*/, "")}</span>
						{/if}
					</p>

					<div
						class="flex max-h-[50vh] flex-col gap-2 overflow-y-auto rounded-lg border border-border-default p-2"
						role="list"
						aria-label="Conversations to import"
					>
						{#if filteredChats.length === 0}
							<p class="py-8 text-center text-sm text-text-muted">
								{$t("chatgptImport.noConversations")}
							</p>
						{:else}
							{#each filteredChats as chat, i (chat.title + chat.createTime)}
								<label
									class="flex cursor-pointer items-center gap-3 rounded-md border border-border-subtle p-3 transition-colors hover:bg-surface-elevated"
									class:bg-surface-elevated={chat.selected}
								>
									<input
										type="checkbox"
										checked={chat.selected}
										onchange={() => toggleChat(i)}
										class="h-4 w-4 accent-accent"
									/>
									<div class="flex flex-1 flex-col gap-0.5">
										<span class="text-sm font-medium text-text-primary">
											{chat.title}
										</span>
										<span class="text-xs text-text-muted">
											{formatDate(chat.createTime)} · {$t("chatgptImport.messages", { count: chat.messageCount })}
										</span>
									</div>
								</label>
							{/each}
						{/if}
					</div>
				</div>
			{:else if state === "config"}
				<div class="flex flex-col gap-4">
					<div class="flex flex-col gap-2">
						<label for="project-select" class="text-sm font-medium text-text-primary">
							{$t("chatgptImport.projectLabel")}
						</label>
						<select
							id="project-select"
							bind:value={selectedProjectId}
							class="rounded-md border border-border-default bg-surface-page px-3 py-2 text-sm text-text-primary focus:border-border-focus focus:outline-none"
						>
							<option value={null}>{$t("chatgptImport.noProject")}</option>
							{#each projects as project (project.id)}
								<option value={project.id}>{project.name}</option>
							{/each}
						</select>
					</div>

					<div class="rounded-lg border border-border-subtle bg-surface-elevated p-3">
						<p class="text-sm text-text-primary">
							{selectedCount} {$t("chatgptImport.messages", { count: selectedCount }).replace(/\d+\s*/, "")} {$t("chatgptImport.chatsFound", { count: selectedCount }).replace(/\d+\s*/, "")}
						</p>
					</div>
				</div>
			{:else if state === "importing"}
				<div class="flex flex-col items-center gap-4 py-4">
					<div class="h-2 w-full overflow-hidden rounded-full bg-surface-elevated">
						<div
							class="h-full rounded-full bg-accent transition-all"
							style="width: {importProgress.total > 0 ? (importProgress.current / importProgress.total) * 100 : 0}%"
						></div>
					</div>
					<p class="text-sm text-text-muted">
						{$t("chatgptImport.processed", {
							current: importProgress.current,
							total: importProgress.total,
						})}
					</p>
				</div>
			{:else if state === "complete"}
				<div class="flex flex-col items-center gap-3 py-4">
					<div class="flex h-12 w-12 items-center justify-center rounded-full bg-success/10">
						<Check class="h-6 w-6 text-success" size={24} strokeWidth={2} aria-hidden="true" />
					</div>
					<p class="text-center text-sm text-text-primary">
						{importResult?.conversationIds.length ?? 0} conversations imported successfully.
					</p>
					{#if importResult && importResult.errors.length > 0}
						<p class="text-center text-xs text-danger">
							{importResult.errors.length} errors occurred.
						</p>
					{/if}
				</div>
			{:else if state === "error"}
				<div class="flex flex-col items-center gap-3 py-4">
					<div class="flex h-12 w-12 items-center justify-center rounded-full bg-danger/10">
						<AlertCircle class="h-6 w-6 text-danger" size={24} strokeWidth={2} aria-hidden="true" />
					</div>
					<p class="text-center text-sm text-danger">{errorMessage}</p>
				</div>
			{/if}

			<div class="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
				{#if state === "upload" || state === "error"}
					<button type="button" class="btn-secondary w-full sm:w-auto" onclick={handleClose}>
						{$t("chatgptImport.cancel")}
					</button>
					{#if state === "error"}
						<button type="button" class="btn-primary w-full sm:w-auto" onclick={handleRetry}>
							{$t("common.retry")}
						</button>
					{/if}
				{:else if state === "preview"}
					<button type="button" class="btn-secondary w-full sm:w-auto" onclick={handleClose}>
						{$t("chatgptImport.cancel")}
					</button>
					<button
						type="button"
						class="btn-primary w-full sm:w-auto"
						disabled={selectedCount === 0}
						onclick={goToConfig}
					>
						{$t("chatgptImport.next")}
					</button>
				{:else if state === "config"}
					<button type="button" class="btn-secondary w-full sm:w-auto" onclick={goBackToPreview}>
						{$t("chatgptImport.back")}
					</button>
					<button
						type="button"
						class="btn-primary w-full sm:w-auto"
						disabled={selectedCount === 0}
						onclick={startImport}
					>
						{$t("chatgptImport.importSelected", { count: selectedCount })}
					</button>
				{:else if state === "importing"}
					<button
						type="button"
						class="btn-secondary w-full sm:w-auto"
						disabled
					>
						{$t("common.loading")}
					</button>
				{:else if state === "complete"}
					<button type="button" class="btn-primary w-full sm:w-auto" onclick={handleClose}>
						{$t("chatgptImport.close")}
					</button>
				{/if}
			</div>
		</div>
	</DialogShell>
{/if}
