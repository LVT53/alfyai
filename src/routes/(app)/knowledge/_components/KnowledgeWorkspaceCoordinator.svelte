<script lang="ts">
import type { KnowledgeDocumentItem, DocumentWorkspaceItem } from "$lib/types";
import { page } from "$app/state";
import { replaceState } from "$app/navigation";
import { browser } from "$app/environment";
import { onDestroy, onMount } from "svelte";
import {
	clearKnowledgeWorkspaceParams,
	getKnowledgeWorkspaceDocumentFromUrl,
} from "$lib/client/document-workspace-navigation";
import {
	reduceWorkspaceClose,
	reduceWorkspaceDocumentsForDeletedConversation,
	reduceWorkspaceDocumentClose,
	reduceWorkspaceDocumentOpen,
	WORKSPACE_CONVERSATION_DELETED_EVENT,
} from "$lib/client/document-workspace-state";
import {
	fetchKnowledgeWorkspaceDocument,
	recordDocumentWorkspaceOpen,
} from "$lib/client/api/knowledge";
import DocumentWorkspace from "$lib/components/document-workspace/DocumentWorkspace.svelte";
import { getWorkspaceDocumentForArtifact } from "../_helpers";
import { toWorkspaceDocument } from "../_helpers";

let {
	documents,
	openRequest = null,
	onJumpToSource,
}: {
	documents: KnowledgeDocumentItem[];
	openRequest?: { sequence: number; document: DocumentWorkspaceItem } | null;
	onJumpToSource?: (document: DocumentWorkspaceItem) => void | Promise<void>;
} = $props();

let workspaceDocuments = $state<DocumentWorkspaceItem[]>([]);
let activeWorkspaceDocumentId = $state<string | null>(null);
let workspaceOpen = $state(false);
let lastHandoffKey = $state<string | null>(null);
let lastOpenRequestSequence = $state<number | null>(null);

let availableWorkspaceDocuments = $derived(documents.map(toWorkspaceDocument));

$effect(() => {
	if (!openRequest || openRequest.sequence === lastOpenRequestSequence) return;
	lastOpenRequestSequence = openRequest.sequence;
	openDocument(openRequest.document);
});

// URL handoff effect
$effect(() => {
	const handoffDoc = getKnowledgeWorkspaceDocumentFromUrl(page.url);
	if (!handoffDoc) return;

	const key = `${handoffDoc.artifactId ?? handoffDoc.id}|${handoffDoc.filename}`;
	if (lastHandoffKey === key) {
		if (browser) {
			requestAnimationFrame(() => {
				replaceState(clearKnowledgeWorkspaceParams(page.url), page.state);
			});
		}
		return;
	}

	lastHandoffKey = key;
	void openHandoffDocument(handoffDoc);
	if (browser) {
		requestAnimationFrame(() => {
			replaceState(clearKnowledgeWorkspaceParams(page.url), page.state);
		});
	}
});

async function openHandoffDocument(handoffDoc: DocumentWorkspaceItem) {
	if (!handoffDoc.artifactId) {
		openDocument(handoffDoc);
		return;
	}

	const localDocument = getWorkspaceDocumentForArtifact(
		documents,
		handoffDoc.artifactId,
	);
	if (localDocument) {
		openDocument(localDocument);
		return;
	}

	try {
		const resolvedDocument = await fetchKnowledgeWorkspaceDocument(
			handoffDoc.artifactId,
		);
		openDocument(
			resolvedDocument ? toWorkspaceDocument(resolvedDocument) : handoffDoc,
		);
	} catch {
		openDocument(handoffDoc);
	}
}

function openDocument(doc: DocumentWorkspaceItem) {
	const result = reduceWorkspaceDocumentOpen(workspaceDocuments, doc);
	workspaceDocuments = result.documents;
	activeWorkspaceDocumentId = result.activeDocumentId;
	workspaceOpen = result.isOpen;

	if (browser && doc.artifactId) {
		void recordDocumentWorkspaceOpen(doc.artifactId).catch(() => undefined);
	}
}

export function closeDocument(documentId?: string) {
	if (!documentId) {
		const result = reduceWorkspaceClose(
			workspaceDocuments,
			activeWorkspaceDocumentId,
		);
		workspaceDocuments = result.documents;
		activeWorkspaceDocumentId = result.activeDocumentId;
		workspaceOpen = result.isOpen;
		return;
	}

	const result = reduceWorkspaceDocumentClose(
		workspaceDocuments,
		documentId,
		activeWorkspaceDocumentId,
	);
	workspaceDocuments = result.documents;
	activeWorkspaceDocumentId = result.activeDocumentId;
	workspaceOpen = result.isOpen;
}

function selectWorkspaceDocument(documentId: string) {
	activeWorkspaceDocumentId = documentId;
	workspaceOpen = true;
	const document = workspaceDocuments.find((entry) => entry.id === documentId);
	if (browser && document?.artifactId) {
		void recordDocumentWorkspaceOpen(document.artifactId).catch(
			() => undefined,
		);
	}
}

function closeWorkspace() {
	const result = reduceWorkspaceClose(
		workspaceDocuments,
		activeWorkspaceDocumentId,
	);
	workspaceDocuments = result.documents;
	activeWorkspaceDocumentId = result.activeDocumentId;
	workspaceOpen = result.isOpen;
}

function handleWorkspaceConversationDeleted(conversationId: string) {
	const nextState = reduceWorkspaceDocumentsForDeletedConversation(
		workspaceDocuments,
		conversationId,
		activeWorkspaceDocumentId,
	);
	if (nextState.documents.length === workspaceDocuments.length) return;

	workspaceDocuments = nextState.documents;
	activeWorkspaceDocumentId = nextState.activeDocumentId;
	workspaceOpen = nextState.isOpen;
}

function handleWorkspaceConversationDeletedEvent(event: Event) {
	const conversationId = (event as CustomEvent<{ conversationId?: unknown }>)
		.detail?.conversationId;
	if (typeof conversationId !== "string") return;
	handleWorkspaceConversationDeleted(conversationId);
}

onMount(() => {
	window.addEventListener(
		WORKSPACE_CONVERSATION_DELETED_EVENT,
		handleWorkspaceConversationDeletedEvent,
	);
});

onDestroy(() => {
	if (!browser) return;
	window.removeEventListener(
		WORKSPACE_CONVERSATION_DELETED_EVENT,
		handleWorkspaceConversationDeletedEvent,
	);
});

// Expose openDocument for external callers (via bind:this)
export function handleOpenDocument(doc: DocumentWorkspaceItem) {
	openDocument(doc);
}
</script>

<DocumentWorkspace
	open={workspaceOpen}
	presentation="expanded"
	returnToDockedOnExpandedClose={false}
	showPresentationToggle={false}
	documents={workspaceDocuments}
	availableDocuments={availableWorkspaceDocuments}
	activeDocumentId={activeWorkspaceDocumentId}
	onSelectDocument={selectWorkspaceDocument}
	onOpenDocument={openDocument}
	onJumpToSource={onJumpToSource}
	onCloseDocument={closeDocument}
	onCloseWorkspace={closeWorkspace}
/>
