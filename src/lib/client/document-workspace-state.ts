import type { DocumentWorkspaceItem } from "$lib/server/services/knowledge/types";

export type WorkspacePresentation = "docked" | "expanded";

export type WorkspaceDocumentState = {
	documents: DocumentWorkspaceItem[];
	activeDocumentId: string | null;
	isOpen: boolean;
};

export type PersistedWorkspaceDocumentState = WorkspaceDocumentState & {
	presentation: WorkspacePresentation;
	updatedAt: number;
};

type WorkspaceEventTarget = Pick<Window, "dispatchEvent">;

const CHAT_WORKSPACE_STATE_STORAGE_KEY = "alfyai-chat-document-workspace";
const MAX_PERSISTED_DOCUMENTS = 12;
const MAX_PERSISTED_STATE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const WORKSPACE_CONVERSATION_DELETED_EVENT =
	"alfyai:workspace-conversation-deleted";

export function reduceWorkspaceDocumentOpen(
	documents: DocumentWorkspaceItem[],
	document: DocumentWorkspaceItem,
): WorkspaceDocumentState {
	const alreadyOpen = documents.some((entry) => entry.id === document.id);
	const updatedDocuments = alreadyOpen
		? documents.map((entry) =>
				entry.id === document.id ? { ...entry, ...document } : entry,
			)
		: [...documents, document];

	return {
		documents: updatedDocuments,
		activeDocumentId: document.id,
		isOpen: true,
	};
}

export function reduceWorkspaceDocumentClose(
	documents: DocumentWorkspaceItem[],
	documentId: string,
	activeWorkspaceDocumentId: string | null,
): WorkspaceDocumentState {
	const remainingDocuments = documents.filter(
		(document) => document.id !== documentId,
	);
	let nextActiveId = activeWorkspaceDocumentId;

	if (activeWorkspaceDocumentId === documentId) {
		nextActiveId = remainingDocuments.at(-1)?.id ?? null;
	}

	return {
		documents: remainingDocuments,
		activeDocumentId: nextActiveId,
		isOpen: remainingDocuments.length > 0,
	};
}

export function reduceWorkspaceClose(
	documents: DocumentWorkspaceItem[],
	activeWorkspaceDocumentId: string | null,
): WorkspaceDocumentState {
	if (documents.length <= 1) {
		return {
			documents: [],
			activeDocumentId: null,
			isOpen: false,
		};
	}

	const activeDocumentId =
		activeWorkspaceDocumentId &&
		documents.some((document) => document.id === activeWorkspaceDocumentId)
			? activeWorkspaceDocumentId
			: (documents.at(-1)?.id ?? null);

	return {
		documents,
		activeDocumentId,
		isOpen: false,
	};
}

function isWorkspaceDocumentFromConversation(
	document: DocumentWorkspaceItem,
	conversationId: string,
): boolean {
	return (
		document.conversationId === conversationId ||
		document.originConversationId === conversationId
	);
}

export function reduceWorkspaceDocumentsForDeletedConversation(
	documents: DocumentWorkspaceItem[],
	deletedConversationId: string,
	activeWorkspaceDocumentId: string | null,
): WorkspaceDocumentState {
	const remainingDocuments = documents.filter(
		(document) =>
			!isWorkspaceDocumentFromConversation(document, deletedConversationId),
	);
	const activeDocumentId =
		activeWorkspaceDocumentId &&
		remainingDocuments.some(
			(document) => document.id === activeWorkspaceDocumentId,
		)
			? activeWorkspaceDocumentId
			: (remainingDocuments.at(-1)?.id ?? null);

	return {
		documents: remainingDocuments,
		activeDocumentId,
		isOpen: remainingDocuments.length > 0,
	};
}

export function loadPersistedWorkspaceDocumentState(
	storage: Pick<Storage, "getItem"> | null | undefined,
	now = Date.now(),
): PersistedWorkspaceDocumentState | null {
	if (!storage) return null;

	const raw = storage.getItem(CHAT_WORKSPACE_STATE_STORAGE_KEY);
	if (!raw) return null;

	try {
		const parsed = JSON.parse(raw) as Partial<PersistedWorkspaceDocumentState>;
		if (!Array.isArray(parsed.documents)) return null;
		if (
			typeof parsed.updatedAt === "number" &&
			now - parsed.updatedAt > MAX_PERSISTED_STATE_AGE_MS
		) {
			return null;
		}

		const documents = parsed.documents.filter(
			(document): document is DocumentWorkspaceItem =>
				Boolean(
					document &&
						typeof document.id === "string" &&
						typeof document.filename === "string" &&
						typeof document.source === "string",
				),
		);
		if (documents.length === 0) return null;

		const activeDocumentId =
			typeof parsed.activeDocumentId === "string" &&
			documents.some((document) => document.id === parsed.activeDocumentId)
				? parsed.activeDocumentId
				: (documents.at(-1)?.id ?? null);

		return {
			documents,
			activeDocumentId,
			isOpen: parsed.isOpen === true,
			presentation: parsed.presentation === "expanded" ? "expanded" : "docked",
			updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : now,
		};
	} catch {
		return null;
	}
}

export function savePersistedWorkspaceDocumentState(
	storage: Pick<Storage, "setItem" | "removeItem"> | null | undefined,
	state: {
		documents: DocumentWorkspaceItem[];
		activeDocumentId: string | null;
		isOpen: boolean;
		presentation: WorkspacePresentation;
	},
	now = Date.now(),
): void {
	if (!storage) return;

	if (state.documents.length === 0) {
		storage.removeItem(CHAT_WORKSPACE_STATE_STORAGE_KEY);
		return;
	}

	const documents = state.documents.slice(-MAX_PERSISTED_DOCUMENTS);
	const activeDocumentId =
		state.activeDocumentId &&
		documents.some((document) => document.id === state.activeDocumentId)
			? state.activeDocumentId
			: (documents.at(-1)?.id ?? null);

	storage.setItem(
		CHAT_WORKSPACE_STATE_STORAGE_KEY,
		JSON.stringify({
			documents,
			activeDocumentId,
			isOpen: state.isOpen,
			presentation: state.presentation,
			updatedAt: now,
		} satisfies PersistedWorkspaceDocumentState),
	);
}

export function removeConversationFromPersistedWorkspaceDocumentState(
	storage:
		| Pick<Storage, "getItem" | "setItem" | "removeItem">
		| null
		| undefined,
	conversationId: string,
	now = Date.now(),
): PersistedWorkspaceDocumentState | null {
	const persisted = loadPersistedWorkspaceDocumentState(storage, now);
	if (!persisted) return null;

	const next = reduceWorkspaceDocumentsForDeletedConversation(
		persisted.documents,
		conversationId,
		persisted.activeDocumentId,
	);
	const presentation = next.isOpen ? persisted.presentation : "docked";

	savePersistedWorkspaceDocumentState(
		storage,
		{
			...next,
			presentation,
		},
		now,
	);

	return next.documents.length > 0
		? {
				...next,
				presentation,
				updatedAt: now,
			}
		: null;
}

export function dispatchWorkspaceConversationDeleted(
	conversationId: string,
	target:
		| WorkspaceEventTarget
		| null
		| undefined = getDefaultWorkspaceEventTarget(),
): void {
	target?.dispatchEvent(
		new CustomEvent(WORKSPACE_CONVERSATION_DELETED_EVENT, {
			detail: { conversationId },
		}),
	);
}

function getDefaultWorkspaceEventTarget(): WorkspaceEventTarget | null {
	return typeof window === "undefined" ? null : window;
}
