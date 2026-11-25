<script lang="ts">
import { tick } from "svelte";
import JSZip from "jszip";
import { t } from "$lib/i18n";
import {
	Upload,
	Check,
	AlertCircle,
	Folder,
	MessageSquare,
} from "@lucide/svelte";
import type { Project } from "$lib/server/services/projects";
import DialogShell from "$lib/components/ui/DialogShell.svelte";
import {
	importChatGPTData,
	packChatGPTUpload,
} from "$lib/client/api/chatgpt-import";
import { ApiError } from "$lib/client/api/http";
import {
	exportedConversationId,
	exportedConversationProjectId,
	readExportedConversations,
} from "$lib/shared/chatgpt-export";

interface ChatGPTConversation {
	id?: string;
	conversation_id?: string;
	title: string;
	create_time: number;
	update_time: number;
	mapping: Record<
		string,
		{ message?: unknown | null; parent?: string | null; children?: string[] }
	>;
}

interface ParsedChat {
	/** What the export calls the conversation: the name the server imports it by. */
	id: string;
	/** The ChatGPT project (a folder in ChatGPT's sidebar) it is in, or null. */
	projectId: string | null;
	title: string;
	createTime: number;
	messageCount: number;
	selected: boolean;
}

/** The chats of one ChatGPT project, or of none, as the list draws them. */
interface ChatGroup {
	/** The project's id, or null for the chats that are in no project. */
	projectId: string | null;
	/** The project's number in the list, from 1; null for the chats in none. */
	number: number | null;
	chats: ParsedChat[];
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

let importState:
	| "upload"
	| "preview"
	| "config"
	| "importing"
	| "complete"
	| "error" = $state("upload");
let file: File | null = $state(null);
let parsedChats: ParsedChat[] = $state([]);
let filteredChats: ParsedChat[] = $state([]);
let searchQuery = $state("");
let selectedProjectId: string | null = $state(null);
let importProgress = $state({ current: 0, total: 0 });
let importResult: {
	conversationIds: string[];
	errors: { conversationTitle?: string; reason: string }[];
} | null = $state(null);
let errorMessage = $state("");
let isDragging = $state(false);
let fileInputRef: HTMLInputElement | null = $state(null);
// The export's conversation entries as read, kept for the upload, which takes
// the ticked ones alone (`packChatGPTUpload`). Plain, not state: nothing is
// drawn from them, and an export's chats can run to tens of megabytes.
let exportEntries: unknown[] = [];

$effect(() => {
	if (!show) {
		// Reset state when modal closes
		tick().then(() => {
			importState = "upload";
			file = null;
			exportEntries = [];
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

const selectedIds = $derived(
	parsedChats.filter((chat) => chat.selected).map((chat) => chat.id),
);

const selectedCount = $derived(selectedIds.length);

// The chats by ChatGPT project, the projects numbered in the order the export
// first lists them (it names none), then the chats in no project. Empty when
// no chat is in a project, and the list is drawn without headings.
const chatGroups: ChatGroup[] = $derived.by(() => {
	const byProject = new Map<string, ChatGroup>();
	const inNoProject: ParsedChat[] = [];
	for (const chat of parsedChats) {
		if (chat.projectId === null) {
			inNoProject.push(chat);
			continue;
		}
		let group = byProject.get(chat.projectId);
		if (!group) {
			group = {
				projectId: chat.projectId,
				number: byProject.size + 1,
				chats: [],
			};
			byProject.set(chat.projectId, group);
		}
		group.chats.push(chat);
	}
	if (byProject.size === 0) return [];
	const groups = [...byProject.values()];
	if (inNoProject.length > 0)
		groups.push({ projectId: null, number: null, chats: inNoProject });
	return groups;
});

const shownChatIds = $derived(new Set(filteredChats.map((chat) => chat.id)));

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
		// The server reads the export the same way, so the list and the import agree.
		const read = await readExportedConversations(zip);
		if (!read.ok) {
			throw new Error(
				$t(
					read.problem === "not_a_list"
						? "chatgptImport.noConversations"
						: "chatgptImport.parseError",
				),
			);
		}
		const data = read.entries as ChatGPTConversation[];

		// An entry the export gives no id cannot be named in what is sent to the
		// server, so it is not offered.
		parsedChats = data.flatMap((conv) => {
			const id = exportedConversationId(conv);
			if (id === null) return [];
			return [
				{
					id,
					projectId: exportedConversationProjectId(conv),
					title: conv.title || "Untitled",
					createTime: conv.create_time,
					messageCount: countMessages(conv.mapping),
					selected: true,
				},
			];
		});
		if (parsedChats.length === 0) {
			throw new Error($t("chatgptImport.noConversations"));
		}
		exportEntries = read.entries;
		filteredChats = parsedChats;
		importState = "preview";
	} catch (err) {
		errorMessage =
			err instanceof Error ? err.message : $t("chatgptImport.parseError");
		importState = "error";
	}
}

function handleFileSelect(uploadedFile: File): void {
	if (!uploadedFile.name.toLowerCase().endsWith(".zip")) {
		errorMessage = $t("chatgptImport.invalidFile");
		importState = "error";
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

function toggleChat(chat: ParsedChat): void {
	chat.selected = !chat.selected;
}

function groupTicks(group: ChatGroup): "all" | "some" | "none" {
	const ticked = group.chats.filter((chat) => chat.selected).length;
	if (ticked === 0) return "none";
	return ticked === group.chats.length ? "all" : "some";
}

// A project's box ticks every chat in it, or unticks them all once all are
// ticked: the whole project, including chats a search hides.
function toggleGroup(group: ChatGroup): void {
	const tickAll = groupTicks(group) !== "all";
	for (const chat of group.chats) chat.selected = tickAll;
}

function goToConfig(): void {
	if (selectedCount === 0) return;
	importState = "config";
}

function goBackToPreview(): void {
	importState = "preview";
}

async function startImport(): Promise<void> {
	if (!file || selectedCount === 0) return;
	importState = "importing";
	importProgress = { current: 0, total: selectedCount };

	try {
		// The ticked conversations go up alone, never the export as picked: its
		// attachments can take it past what the server accepts in one request.
		const upload = await packChatGPTUpload(exportEntries, selectedIds);
		const result = await importChatGPTData(
			upload,
			selectedIds,
			selectedProjectId,
		);
		importResult = {
			conversationIds: result.conversationIds,
			errors: result.errors,
		};
		importProgress = { current: selectedCount, total: selectedCount };
		importState = "complete";
	} catch (err) {
		// The server names this refusal by key, so it reads in the reader's
		// language; any other failure keeps the server's own sentence.
		errorMessage =
			err instanceof ApiError && err.errorKey === "chatgptImport.alreadyRunning"
				? $t("chatgptImport.alreadyRunning")
				: err instanceof Error
					? err.message
					: $t("chatgptImport.importError");
		importState = "error";
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
	importState = "upload";
}
</script>

{#snippet chatRow(chat: ParsedChat, inGroup: boolean)}
	<label
		class="flex cursor-pointer items-center gap-3 rounded-md border border-border-subtle p-3 transition-colors hover:bg-surface-elevated"
		class:ml-6={inGroup}
		class:bg-surface-elevated={chat.selected}
	>
		<input
			type="checkbox"
			checked={chat.selected}
			onchange={() => toggleChat(chat)}
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
{/snippet}

{#if show}
	<DialogShell
		title={importState === "upload"
			? $t("chatgptImport.title")
			: importState === "preview"
				? $t("chatgptImport.previewTitle")
				: importState === "config"
					? $t("chatgptImport.configTitle")
					: importState === "importing"
						? $t("chatgptImport.importingTitle")
						: importState === "complete"
							? $t("chatgptImport.importComplete")
							: $t("chatgptImport.importError")}
		description={importState === "upload" ? $t("chatgptImport.description") : undefined}
		onClose={handleClose}
		maxWidthClass={importState === "preview" || importState === "config" ? "max-w-[640px]" : "max-w-[480px]"}
		zIndexClass="z-50"
	>
		<div class="flex flex-col gap-4">
			{#if importState === "upload"}
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
			{:else if importState === "preview"}
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
							class="btn-secondary whitespace-nowrap"
							onclick={toggleSelectAll}
						>
							{allSelected ? $t("chatgptImport.deselectAll") : $t("chatgptImport.selectAll")}
						</button>
					</div>

					<p class="text-xs text-text-muted">
						{$t("chatgptImport.chatsFound", { count: filteredChats.length })}
						{#if selectedCount > 0}
							<span class="ml-1">· {$t("chatgptImport.selectedCount", { count: selectedCount })}</span>
						{/if}
					</p>
					{#if chatGroups.length > 0}
						<p class="text-xs text-text-muted">{$t("chatgptImport.projectsNote")}</p>
					{/if}

					<div
						class="flex max-h-[50vh] flex-col gap-2 overflow-y-auto rounded-lg border border-border-default p-2"
						role="list"
						aria-label={$t('chatgptImport.conversationListLabel')}
					>
						{#if filteredChats.length === 0}
							<p class="py-8 text-center text-sm text-text-muted">
								{$t("chatgptImport.noConversations")}
							</p>
						{:else if chatGroups.length === 0}
							{#each filteredChats as chat (chat.id)}
								{@render chatRow(chat, false)}
							{/each}
						{:else}
							{#each chatGroups as group (group.projectId ?? "")}
								{@const shown = group.chats.filter((chat) => shownChatIds.has(chat.id))}
								{#if shown.length > 0}
									{@const ticks = groupTicks(group)}
									<label
										class="flex cursor-pointer items-center gap-3 rounded-md p-2 transition-colors hover:bg-surface-elevated"
										data-testid="chatgpt-import-group"
									>
										<input
											type="checkbox"
											checked={ticks === "all"}
											indeterminate={ticks === "some"}
											onchange={() => toggleGroup(group)}
											class="h-4 w-4 accent-accent"
										/>
										{#if group.number === null}
											<MessageSquare class="h-4 w-4 shrink-0 text-icon-muted" size={16} strokeWidth={1.75} aria-hidden="true" />
										{:else}
											<Folder class="h-4 w-4 shrink-0 text-icon-muted" size={16} strokeWidth={1.75} aria-hidden="true" />
										{/if}
										<div class="flex flex-1 flex-col gap-0.5">
											<span class="text-sm font-medium text-text-primary">
												{group.number === null
													? $t("chatgptImport.noProjectGroup")
													: $t("chatgptImport.projectGroup", { number: group.number })}
											</span>
											<span class="text-xs text-text-muted">
												{$t("chatgptImport.groupCount", { count: group.chats.length })}
											</span>
										</div>
									</label>
									{#each shown as chat (chat.id)}
										{@render chatRow(chat, true)}
									{/each}
								{/if}
							{/each}
						{/if}
					</div>
				</div>
			{:else if importState === "config"}
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
							{$t("chatgptImport.willImport", { count: selectedCount })}
						</p>
					</div>
					<p class="text-xs text-text-muted">{$t("chatgptImport.memoryNote")}</p>
				</div>
			{:else if importState === "importing"}
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
			{:else if importState === "complete"}
				<div class="flex flex-col items-center gap-3 py-4">
					<div class="flex h-12 w-12 items-center justify-center rounded-full bg-success/10">
						<Check class="h-6 w-6 text-success" size={24} strokeWidth={2} aria-hidden="true" />
					</div>
					<p class="text-center text-sm text-text-primary">
						{$t("chatgptImport.importedCount", {
							count: importResult?.conversationIds.length ?? 0,
						})}
					</p>
					{#if importResult && importResult.errors.length > 0}
						<p class="text-center text-xs text-danger">
							{$t("chatgptImport.importedErrorCount", {
								count: importResult.errors.length,
							})}
						</p>
					{/if}
				</div>
			{:else if importState === "error"}
				<div class="flex flex-col items-center gap-3 py-4">
					<div class="flex h-12 w-12 items-center justify-center rounded-full bg-danger/10">
						<AlertCircle class="h-6 w-6 text-danger" size={24} strokeWidth={2} aria-hidden="true" />
					</div>
					<p class="text-center text-sm text-danger">{errorMessage}</p>
				</div>
			{/if}

			<div class="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
				{#if importState === "upload" || importState === "error"}
					<button type="button" class="btn-secondary w-full sm:w-auto" onclick={handleClose}>
						{$t("chatgptImport.cancel")}
					</button>
					{#if importState === "error"}
						<button type="button" class="btn-primary w-full sm:w-auto" onclick={handleRetry}>
							{$t("common.retry")}
						</button>
					{/if}
				{:else if importState === "preview"}
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
				{:else if importState === "config"}
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
				{:else if importState === "importing"}
					<button
						type="button"
						class="btn-secondary w-full sm:w-auto"
						disabled
					>
						{$t("common.loading")}
					</button>
				{:else if importState === "complete"}
					<button type="button" class="btn-primary w-full sm:w-auto" onclick={handleClose}>
						{$t("chatgptImport.close")}
					</button>
				{/if}
			</div>
		</div>
	</DialogShell>
{/if}
