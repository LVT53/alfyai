<script lang="ts">
import { onMount, tick } from "svelte";
import { fly } from "svelte/transition";
import { ArrowLeft, Check, Info } from "@lucide/svelte";
import { t, type I18nKey } from "$lib/i18n";
import { projects } from "$lib/stores/projects";
import {
	fetchMemoryPage,
	fetchMemoryDetail,
	fetchMemoryOperation,
	fetchMemoryOperationByRequest,
	submitMemoryAction,
} from "$lib/client/api/memory";
import { ApiError } from "$lib/client/api/http";
import ErrorMessage from "$lib/components/chat/ErrorMessage.svelte";
import type {
	MemoryAction,
	MemoryDetail as Detail,
	MemoryOperation,
	MemoryPage,
	MemoryRef,
	MemoryRow,
	MemoryScope,
} from "$lib/memory-types";
import {
	reducedMotionAware,
	prefersReducedMotion,
	MOTION_DURATION,
	MOTION_EASE,
} from "$lib/utils/motion";
import type { MemoryVisit } from "./memory-visit";
import MemoryList from "./MemoryList.svelte";
import MemoryQuarantineReview from "./MemoryQuarantineReview.svelte";
import MemoryDetail from "./MemoryDetail.svelte";
import MemoryEditor from "./MemoryEditor.svelte";
import MemoryRemoveDialog from "./MemoryRemoveDialog.svelte";
import "./memory-replacement.css";
let { memoryEnabled }: { memoryEnabled: boolean | null } = $props();
let view = $state<"list" | "detail" | "edit" | "add" | "remove">("list");
let scopeValue = $state("personal");
let query = $state("");
let draft = $state("");
const scope = $derived<MemoryScope>(
	scopeValue === "personal"
		? { kind: "personal" }
		: { kind: "project", projectId: scopeValue },
);
const scopeLabel = $derived(
	scopeValue === "personal"
		? $t("memoryNew.personal")
		: ($projects.find((p) => p.id === scopeValue)?.name ??
				$t("memoryNew.project")),
);
let page = $state<MemoryPage | null>(null);
let detail = $state<Detail | null>(null);
let loading = $state(true);
let detailLoading = $state(false);
let operation = $state<MemoryOperation | null>(null);
let action = $state<MemoryAction | null>(null);
let pending = $state<MemoryVisit["pending"]>(null);
let submitting = $state(false);
let unknownAcknowledgement = $state(false);
let polling = $state(false);
let staleRef = $state<MemoryRef | null>(null);
let latestDetail = $state<Detail | null>(null);
let missingLatest = $state(false);
let error = $state("");
let errorRetry = $state<(() => void) | null>(null);
let errorOwner = "";
let notice = $state("");
let backgroundErrorDismissed = $state("");
let root: HTMLElement | undefined = $state();
let alive = false;
let navigationEpoch = 0;
let submissionEpoch = -1;
let detached = $state<NonNullable<MemoryVisit["pending"]>[]>([]);
let reconcilingDetached = false;
let detachedTimer: ReturnType<typeof setTimeout> | undefined;
let loadSequence = 0;
let detailSequence = 0;
let reviewSequence = 0;
let pagesLoaded = 1;
let rememberedRow = "";
let listScroll = 0;
let listAbort: AbortController | undefined;
let detailAbort: AbortController | undefined;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let backgroundTimer: ReturnType<typeof setTimeout> | undefined;
const change = reducedMotionAware(fly);
const scopeKey = (value: MemoryScope) =>
	value.kind === "personal" ? "personal" : value.projectId;
const refKey = (ref: MemoryRef) => `${scopeKey(ref.scope)}:${ref.rowId}`;
const pendingHere = $derived(
	pending !== null &&
		scopeKey(pending.scope) === scopeValue &&
		(view === "list" ||
			pending.rowId === detail?.row.ref.rowId ||
			(pending.kind === "add" && view === "add")),
);
const busy = $derived(
	submitting ||
		unknownAcknowledgement ||
		operation?.status === "queued" ||
		operation?.status === "working",
);
const editorBusy = $derived(pendingHere && busy);
const stale = $derived(
	staleRef !== null &&
		detail !== null &&
		refKey(staleRef) === refKey(detail.row.ref) &&
		view !== "list",
);
const excludedHere = $derived(
	pendingHere && Boolean(operation?.exclusionAcknowledged),
);
const memoryOff = $derived(memoryEnabled === false || page?.status === "off");
const disabled = $derived(
	!page || memoryOff || page.authority !== "hindsight" || busy,
);
const retryMutation = () => void send(true);
function fail(key: I18nKey, retry: (() => void) | null, owner = "view") {
	error = $t(key);
	errorRetry = retry;
	errorOwner = owner;
}
function clearError(owner?: string) {
	if (!owner || owner === errorOwner) {
		error = "";
		errorRetry = null;
		errorOwner = "";
	}
}
function isAbort(value: unknown) {
	return value instanceof Error && value.name === "AbortError";
}
function scroller() {
	return (
		root?.closest<HTMLElement>('[data-testid="knowledge-scroller"]') ?? null
	);
}
function invalidateNavigation() {
	navigationEpoch++;
	detailSequence++;
	reviewSequence++;
	detailAbort?.abort();
	detailLoading = false;
	latestDetail = null;
	missingLatest = false;
}
async function setView(next: typeof view, focus = true) {
	invalidateNavigation();
	view = next;
	clearError();
	await tick();
	if (!alive || !focus) return;
	const target =
		root?.querySelector<HTMLElement>("[data-memory-heading]") ??
		root?.querySelector<HTMLElement>("textarea,.memory-back");
	target?.focus({ preventScroll: true });
	if (next !== "list")
		root?.scrollIntoView?.({
			block: "start",
			behavior: prefersReducedMotion() ? "instant" : "smooth",
		});
}
function resetRecordFeedback() {
	staleRef = null;
	latestDetail = null;
	missingLatest = false;
	clearError();
}
function activeRead(epoch: number, key: string) {
	return alive && epoch === navigationEpoch && key === scopeValue;
}
function accessLost(cause: unknown) {
	return cause instanceof ApiError && [401, 403, 404].includes(cause.status);
}
function discardScopeContent() {
	invalidateNavigation();
	page = null;
	detail = null;
	draft = "";
	view = "list";
	resetRecordFeedback();
}
function scheduleBackground() {
	clearTimeout(backgroundTimer);
	if (
		page?.status === "queued" ||
		page?.status === "working" ||
		page?.status === "failed"
	)
		backgroundTimer = setTimeout(() => {
			if (alive) void load("refresh");
		}, 3000);
}
async function load(mode: "replace" | "more" | "refresh" = "replace") {
	const seq = ++loadSequence;
	const requestedScope = scope;
	const requestedQuery = query;
	const requestedKey = scopeValue;
	listAbort?.abort();
	listAbort = new AbortController();
	loading = true;
	const wanted = mode === "refresh" ? pagesLoaded : 1;
	const base = mode === "more" ? page : null;
	const firstCursor = base?.nextCursor;
	try {
		let result = await fetchMemoryPage(
			{
				scope: requestedScope,
				query: requestedQuery,
				...(firstCursor ? { cursor: firstCursor } : {}),
			},
			listAbort.signal,
		);
		if (
			!alive ||
			seq !== loadSequence ||
			requestedKey !== scopeValue ||
			requestedQuery !== query
		)
			return;
		if (base && base.generation !== result.generation) {
			void load("refresh");
			return;
		}
		let rows = base ? [...base.rows, ...result.rows] : result.rows;
		let count = mode === "more" ? pagesLoaded + 1 : 1;
		while (mode === "refresh" && count < wanted && result.nextCursor) {
			const next = await fetchMemoryPage(
				{
					scope: requestedScope,
					query: requestedQuery,
					cursor: result.nextCursor,
				},
				listAbort.signal,
			);
			if (!alive || seq !== loadSequence) return;
			if (next.generation !== result.generation)
				throw new Error("Memory changed while paging");
			rows = [...rows, ...next.rows];
			result = next;
			count++;
		}
		if (!alive || seq !== loadSequence) return;
		page = { ...result, rows };
		pagesLoaded = count;
		clearError("list");
		scheduleBackground();
	} catch (cause) {
		if (!isAbort(cause) && alive && seq === loadSequence) {
			if (accessLost(cause)) discardScopeContent();
			scheduleBackground();
			fail("memoryNew.loadFailed", () => void load(mode), "list");
		}
	} finally {
		if (seq === loadSequence) loading = false;
	}
}
function search() {
	clearTimeout(searchTimer);
	searchTimer = setTimeout(() => void load(), 180);
}
function selectScope(value: string) {
	invalidateNavigation();
	scopeValue = value;
	query = "";
	page = null;
	pagesLoaded = 1;
	notice = "";
	resetRecordFeedback();
	void load();
}
async function open(
	row: MemoryRow,
	button?: HTMLButtonElement,
	refresh = false,
) {
	if (button) {
		rememberedRow = row.ref.rowId;
		listScroll = scroller()?.scrollTop ?? 0;
	}
	const epoch = navigationEpoch;
	const key = scopeValue;
	const seq = ++detailSequence;
	detailAbort?.abort();
	detailAbort = new AbortController();
	detailLoading = true;
	try {
		const result = await fetchMemoryDetail(row.ref, detailAbort.signal);
		if (!activeRead(epoch, key) || seq !== detailSequence) return;
		detail = result;
		if (!refresh) {
			resetRecordFeedback();
			await setView("detail");
		}
	} catch (cause) {
		if (isAbort(cause) || !activeRead(epoch, key) || seq !== detailSequence)
			return;
		if (accessLost(cause)) {
			discardScopeContent();
			fail("memoryNew.unavailable", () => void load("refresh"));
			return;
		}
		if (
			cause instanceof ApiError &&
			(cause.status === 404 || cause.status === 409)
		) {
			if (refresh && detail) {
				staleRef = detail.row.ref;
				if (cause.status === 404) {
					detail = null;
					await setView("list");
				}
			}
			fail(
				cause.status === 409 ? "memoryNew.stale" : "memoryNew.unavailable",
				() => void load("refresh"),
			);
			void load("refresh");
		} else
			fail("memoryNew.loadFailed", () => void open(row, undefined, refresh));
	} finally {
		if (seq === detailSequence) detailLoading = false;
	}
}
function restoreListFocus(preferred: "row" | "add" | "search" = "row") {
	const scrollContainer = scroller();
	if (scrollContainer) scrollContainer.scrollTop = listScroll;
	const target =
		preferred === "row" && rememberedRow
			? root?.querySelector<HTMLButtonElement>(
					`[data-memory-row="${CSS.escape(rememberedRow)}"]`,
				)
			: preferred === "add"
				? root?.querySelector<HTMLButtonElement>("[data-memory-add]:enabled")
				: null;
	if (target) target.focus({ preventScroll: true });
	else root?.querySelector<HTMLInputElement>("[data-memory-search]")?.focus();
}
async function back(preferred: "row" | "search" = "row") {
	const target = view === "add" ? "add" : missingLatest ? "search" : preferred;
	const switching = setView("list", false);
	const epoch = navigationEpoch;
	resetRecordFeedback();
	await switching;
	if (alive && epoch === navigationEpoch) restoreListFocus(target);
}
function clearSettledIntent() {
	if (!busy) {
		operation = null;
		action = null;
		pending = null;
		unknownAcknowledgement = false;
	}
}
function startEdit() {
	if (!detail || disabled || excludedHere) return;
	clearSettledIntent();
	draft = detail.row.text;
	resetRecordFeedback();
	void setView("edit");
}
function startAdd() {
	if (disabled) return;
	listScroll = scroller()?.scrollTop ?? 0;
	clearSettledIntent();
	draft = "";
	detail = null;
	resetRecordFeedback();
	void setView("add");
}
function startRemove() {
	if (disabled || excludedHere) return;
	clearSettledIntent();
	resetRecordFeedback();
	void setView("remove");
}
function draftChanged(value: string) {
	if (
		!busy &&
		action &&
		action.kind !== "remove" &&
		action.text !== value.trim()
	) {
		clearSettledIntent();
		clearError();
	}
}
async function findCurrentRow(
	ref: MemoryRef,
	valid: () => boolean,
): Promise<MemoryRow | null> {
	let cursor: string | undefined;
	let generation: string | undefined;
	const seen = new Set<string>();
	do {
		const result = await fetchMemoryPage({
			scope: ref.scope,
			...(cursor ? { cursor } : {}),
		});
		if (!valid()) return null;
		if (generation && generation !== result.generation)
			throw new Error("Memory changed while paging");
		generation = result.generation;
		const found = result.rows.find((row) => row.ref.rowId === ref.rowId);
		if (found) return found;
		cursor = result.nextCursor ?? undefined;
		if (cursor && seen.has(cursor)) throw new Error("Invalid memory cursor");
		if (cursor) seen.add(cursor);
	} while (cursor);
	return null;
}
async function checkLatest() {
	if (!staleRef || !detail) return;
	const ref = staleRef;
	const epoch = navigationEpoch;
	const key = scopeValue;
	const seq = ++reviewSequence;
	const valid = () =>
		activeRead(epoch, key) &&
		seq === reviewSequence &&
		staleRef !== null &&
		refKey(staleRef) === refKey(ref);
	detailLoading = true;
	missingLatest = false;
	try {
		const row = await findCurrentRow(ref, valid);
		if (!valid()) return;
		if (!row) {
			missingLatest = true;
			return;
		}
		const next = await fetchMemoryDetail(row.ref);
		if (!valid()) return;
		latestDetail = next;
		clearError();
	} catch {
		if (valid()) fail("memoryNew.loadFailed", () => void checkLatest());
	} finally {
		if (valid()) detailLoading = false;
	}
}
function continueEditing() {
	if (!latestDetail) return;
	detail = latestDetail;
	staleRef = null;
	latestDetail = null;
	clearSettledIntent();
	clearError();
}
function schedulePoll() {
	clearTimeout(pollTimer);
	if (alive && pending && (busy || operation?.cleanupPending))
		pollTimer = setTimeout(() => void poll(), 2000);
}
async function settle(result: MemoryOperation, showCompletion = true) {
	if (!alive) return;
	unknownAcknowledgement = false;
	operation = result;
	if (pending) pending = { ...pending, operationId: result.id };
	clearError("operation");
	if (result.status === "queued" || result.status === "working") {
		schedulePoll();
		return;
	}
	if (result.status === "stale") {
		if (action && action.kind !== "add") staleRef = action.ref;
		fail("memoryNew.stale", null, "operation");
		return;
	}
	if (result.status === "failed") {
		if (pendingHere)
			fail(
				pending?.kind === "remove"
					? result.exclusionAcknowledged
						? "memoryNew.excluded"
						: "memoryNew.removeFailed"
					: "memoryNew.saveFailed",
				result.retryable && action ? retryMutation : null,
				"operation",
			);
		if (result.exclusionAcknowledged) void load("refresh");
		schedulePoll();
		return;
	}
	const completed = pending;
	const relevant = pendingHere && submissionEpoch === navigationEpoch;
	if (!result.cleanupPending) {
		pending = null;
		action = null;
		operation = null;
		clearTimeout(pollTimer);
	}
	notice = relevant
		? $t(completed?.kind === "remove" ? "memoryNew.removed" : "memoryNew.saved")
		: notice;
	const epoch = navigationEpoch;
	void load("refresh");
	if (!showCompletion || !relevant || !activeRead(epoch, scopeValue)) return;
	// Leave the editor before fetching the accepted detail: a failed refresh must
	// never leave Save pointing at an already completed action.
	if (completed?.kind === "remove") {
		detail = null;
		await back("search");
	} else {
		await back();
		if (result.ref)
			await open({ ref: result.ref, text: "", updatedAt: "", sourceCount: 0 });
	}
	schedulePoll();
}
async function poll() {
	if (!pending || !alive || polling) return;
	polling = true;
	const identity = pending.requestId;
	try {
		const result = pending.operationId
			? await fetchMemoryOperation(pending.operationId)
			: await fetchMemoryOperationByRequest(identity);
		if (!alive || pending?.requestId !== identity) return;
		await settle(result);
	} catch (cause) {
		if (!alive || pending?.requestId !== identity) return;
		fail("memoryNew.statusUnknown", () => void recheck(), "operation");
		if (
			cause instanceof ApiError &&
			cause.status === 404 &&
			action &&
			unknownAcknowledgement
		) {
			/* Not accepted yet: replay is explicit, with the same request id. */
		}
	} finally {
		polling = false;
		schedulePoll();
	}
}
async function recheck() {
	if (unknownAcknowledgement && action && !memoryOff) await send(true);
	else await poll();
}
async function send(retry = false) {
	if (submitting || memoryOff) return;
	if (!retry) {
		if (disabled || stale) return;
		const same =
			action && (action.kind === "remove" || action.text === draft.trim());
		if (!same) {
			action =
				view === "add"
					? {
							kind: "add",
							scope,
							text: draft.trim(),
							requestId: crypto.randomUUID(),
						}
					: detail
						? view === "remove"
							? {
									kind: "remove",
									ref: detail.row.ref,
									requestId: crypto.randomUUID(),
								}
							: {
									kind: "edit",
									ref: detail.row.ref,
									text: draft.trim(),
									requestId: crypto.randomUUID(),
								}
						: null;
		}
	}
	if (!action) return;
	const submitted = action;
	pending = {
		requestId: submitted.requestId,
		operationId: null,
		kind: submitted.kind,
		scope: submitted.kind === "add" ? submitted.scope : submitted.ref.scope,
		rowId: submitted.kind === "add" ? null : submitted.ref.rowId,
	};
	submitting = true;
	submissionEpoch = navigationEpoch;
	clearError();
	try {
		const result = await submitMemoryAction(submitted);
		if (!alive) return;
		submitting = false;
		await settle(result);
	} catch (cause) {
		if (!alive) return;
		submitting = false;
		if (
			cause instanceof ApiError &&
			cause.status >= 400 &&
			cause.status < 500 &&
			cause.status !== 408 &&
			cause.status !== 429
		) {
			unknownAcknowledgement = false;
			if (cause.status === 409 && submitted.kind !== "add") {
				staleRef = submitted.ref;
				fail("memoryNew.stale", null, "operation");
			} else {
				operation = null;
				pending = null;
				action = null;
				fail(
					submitted.kind === "remove"
						? "memoryNew.removeFailed"
						: "memoryNew.saveFailed",
					null,
					"operation",
				);
			}
		} else {
			unknownAcknowledgement = true;
			fail("memoryNew.statusUnknown", () => void recheck(), "operation");
			schedulePoll();
		}
	} finally {
		submitting = false;
	}
}
async function reconcileDetached() {
	if (reconcilingDetached) return;
	reconcilingDetached = true;
	clearTimeout(detachedTimer);
	try {
		for (const request of [...detached]) {
			try {
				const result = request.operationId
					? await fetchMemoryOperation(request.operationId)
					: await fetchMemoryOperationByRequest(request.requestId);
				if (!alive) return;
				if (
					result.status !== "queued" &&
					result.status !== "working" &&
					!result.cleanupPending
				) {
					detached = detached.filter(
						(item) => item.requestId !== request.requestId,
					);
					if (scopeKey(request.scope) === scopeValue) void load("refresh");
				} else
					detached = detached.map((item) =>
						item.requestId === request.requestId
							? { ...item, operationId: result.id }
							: item,
					);
			} catch {
				/* Lookup failure, including 404, is not proof of nonapplication. */
			}
		}
	} finally {
		reconcilingDetached = false;
		if (alive && detached.length)
			detachedTimer = setTimeout(() => void reconcileDetached(), 3000);
	}
}
export function capture(): MemoryVisit {
	return {
		scopeValue,
		detached: [...detached],
		query,
		pages: pagesLoaded,
		rowId: rememberedRow,
		scrollTop:
			view === "list" ? (scroller()?.scrollTop ?? listScroll) : listScroll,
		pending:
			pending && (busy || operation?.cleanupPending) ? { ...pending } : null,
	};
}
export async function restore(value: MemoryVisit) {
	invalidateNavigation();
	const epoch = navigationEpoch;
	page = null;
	detail = null;
	draft = "";
	resetRecordFeedback();
	scopeValue = value.scopeValue;
	query = value.query;
	pagesLoaded = Math.max(1, value.pages);
	rememberedRow = value.rowId;
	listScroll = value.scrollTop;
	detached = [
		...(value.detached ?? []),
		...(value.pending ? [value.pending] : []),
	];
	pending = null;
	operation = null;
	action = null;
	unknownAcknowledgement = Boolean(pending);
	view = "list";
	if (!alive) return;
	await load("refresh");
	await tick();
	if (!alive || epoch !== navigationEpoch) return;
	if (rememberedRow) restoreListFocus();
	else {
		const scrollContainer = scroller();
		if (scrollContainer) scrollContainer.scrollTop = listScroll;
	}
	if (pending) void poll();
	if (detached.length) void reconcileDetached();
}
onMount(() => {
	alive = true;
	void load();
	if (pending) void poll();
	if (detached.length) void reconcileDetached();
	const refresh = () => {
		void load("refresh");
		if (pending) void poll();
		if (detached.length) void reconcileDetached();
		if (view === "detail" && detail) void open(detail.row, undefined, true);
	};
	window.addEventListener("focus", refresh);
	return () => {
		alive = false;
		invalidateNavigation();
		loadSequence++;
		listAbort?.abort();
		clearTimeout(searchTimer);
		clearTimeout(pollTimer);
		clearTimeout(backgroundTimer);
		clearTimeout(detachedTimer);
		window.removeEventListener("focus", refresh);
	};
});
</script>
<section class="memory-replacement" bind:this={root} data-testid="memory-replacement">
 <div class="sr-only" role="status" aria-live="polite">{notice}</div>
 {#if error}<ErrorMessage {error} canRetry={errorRetry!==null&&(!memoryOff||errorRetry!==retryMutation)} onRetry={()=>errorRetry?.()} onClose={()=>clearError()}/>{/if}
 {#if memoryOff}<div class="memory-notice" data-testid="memory-off-notice" role="status"><Info size={18} strokeWidth={1.8} aria-hidden="true"/><div><strong>{$t('memoryNew.off')}</strong><p>{$t('memoryNew.offHelp')}</p></div></div>{/if}
 {#if page?.authority==='legacy'||page?.authority==='preparing'}<div class="memory-notice"><Info size={18} strokeWidth={1.8} aria-hidden="true"/><div><strong>{$t('memoryNew.preparing')}</strong><p>{$t('memoryNew.preparingHelp')}</p></div></div>{/if}
 {#if detached.length}<p class="memory-status" role="status">{$t("memoryNew.statusUnknown")}<button class="btn-ghost memory-button" onclick={()=>void reconcileDetached()}>{$t("memoryNew.checkStatus")}</button></p>{/if}
 {#if pendingHere&&busy}<p class="memory-status" role="status">{$t('memoryNew.pending')}<button type="button" class="btn-ghost memory-button" onclick={()=>void recheck()} disabled={polling||submitting}>{$t('memoryNew.checkStatus')}</button></p>{:else if pendingHere&&operation?.exclusionAcknowledged&&operation.cleanupPending}<p class="memory-status" role="status">{$t('memoryNew.excluded')}</p>{/if}
 {#if detailLoading}<p class="memory-status" role="status">{$t('memoryNew.loading')}</p>{/if}
 {#if stale}<div class="memory-notice"><Info size={18} strokeWidth={1.8} aria-hidden="true"/><div><p>{$t('memoryNew.stale')}</p>{#if latestDetail}<blockquote>{latestDetail.row.text}</blockquote><button type="button" class="btn-secondary memory-button" onclick={continueEditing}>{$t('memoryNew.continueEditing')}</button>{:else if missingLatest}<p>{$t("memoryNew.identityChanged")}</p><button type="button" class="btn-secondary memory-button" onclick={()=>void back()}>{$t("memoryNew.back")}</button>{:else}<button type="button" class="btn-secondary memory-button" onclick={()=>void checkLatest()} disabled={detailLoading}>{$t('memoryNew.reviewLatest')}</button>{/if}</div></div>{/if}
 {#key view}<div in:change={{x:view==='list'?-8:8,duration:MOTION_DURATION.standard,easing:MOTION_EASE.out}}>
 {#if view==='list'}
  <header class="memory-heading"><h2 tabindex="-1" data-memory-heading>{$t('memoryNew.title')}</h2><p class="memory-description">{$t('memoryNew.intro')}</p></header>
  {#if page?.status==='queued'||page?.status==='working'}<p class="memory-status" role="status">{$t('memoryNew.updating')} {$t('memoryNew.updatingHelp')}</p>{:else if page?.status==='failed'&&backgroundErrorDismissed!==`${scopeValue}:${page.generation}`}<ErrorMessage error={$t('memoryNew.backgroundFailed')} canRetry={false} onRetry={()=>{}} onClose={()=>backgroundErrorDismissed=`${scopeValue}:${page?.generation}`}/>{/if}
  <MemoryQuarantineReview projects={$projects} {memoryOff} preparing={page?.authority === "preparing"} onKeep={() => void load("refresh")}/>
  <MemoryList {page} bind:query {scopeValue} projects={$projects} {loading} {disabled} busy={false} onScope={selectScope} onSearch={search} onOpen={open} onAdd={startAdd} onMore={()=>void load("more")}/>
  {#if notice}<p class="memory-status"><Check size={15} strokeWidth={1.8} aria-hidden="true"/>{notice}</p>{/if}
 {:else}
  <button type="button" class="btn-ghost memory-back memory-button" onclick={()=>void back()}><ArrowLeft size={16} strokeWidth={1.8} aria-hidden="true"/>{$t('memoryNew.back')}</button>
  {#if view==='detail'&&detail}<MemoryDetail {detail} {scopeLabel} disabled={disabled||stale||excludedHere} onEdit={startEdit} onRemove={startRemove}/>
  {:else if view==='edit'||view==='add'}<MemoryEditor bind:draft savedText={view==='edit'?(detail?.row.text??null):null} {scopeLabel} busy={editorBusy} disabled={disabled||stale} onDraftChange={draftChanged} onSave={()=>void send()} onCancel={()=>{if(view==='add')void back();else void setView('detail');}}/>
  {:else if view==='remove'&&detail}<MemoryRemoveDialog text={detail.row.text} {scopeLabel} busy={editorBusy} disabled={disabled||stale||excludedHere} onRemove={()=>void send()} onCancel={()=>void setView('detail')}/>{/if}
 {/if}</div>{/key}
</section>
