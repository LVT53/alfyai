// Issue 7.5 — inline write-confirm card DTO. Mirrors the shape returned by
// GET /api/conversations/[id]/pending-writes (see write-guard.ts's own
// `WritePreview` for the server-side build-time source of truth this is
// kept in sync with, and pending-writes.ts's own `PendingWriteStatus` for
// the storage-row lifecycle this projects) and by
// $lib/client/api/connection-writes.ts's confirm/cancel calls. Named
// distinctly from those two modules' local types to avoid colliding with
// them — this is the client-facing read/confirm view, not the storage row
// or the build-time preview. Relocated out of the former
// src/lib/types.ts god-module (architecture-deepening T1); this file
// carries no behavior change, only a new home.

export type PendingWriteStatus =
	| "pending"
	| "executing"
	| "executed"
	| "cancelled"
	| "failed";

export interface WritePreview {
	title: string;
	detail: string;
	reversible: boolean;
	destructive: boolean;
	withinAllowlist: boolean | null;
	warnings: string[];
}

export interface PendingWrite {
	id: string;
	conversationId: string | null;
	assistantMessageId: string | null;
	status: PendingWriteStatus;
	preview: WritePreview;
	provider: string;
	createdAt: number;
	etag?: string | null;
}
