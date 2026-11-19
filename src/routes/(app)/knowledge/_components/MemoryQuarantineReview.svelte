<script lang="ts">
import { ArrowUpRight, Info } from "@lucide/svelte";
import { onDestroy, tick } from "svelte";
import { ApiError } from "$lib/client/api/http";
import {
	fetchMemoryQuarantine,
	saveMemoryQuarantine,
} from "$lib/client/api/memory";
import { buildChatSourceMessageHref } from "$lib/client/document-workspace-navigation";
import { t } from "$lib/i18n";
import type {
	MemoryQuarantine,
	MemoryQuarantineCandidate,
	MemoryQuarantineRequest,
} from "$lib/memory-types";
import { uiLanguage } from "$lib/stores/settings";

type Decision =
	| { action: "start" }
	| { action: "retry"; id: string }
	| { action: "resolve"; id: string; decision: "discard" }
	| { action: "resolve"; id: string; decision: "keep"; text?: string };

let {
	projects,
	memoryOff,
	preparing = false,
	onKeep = () => {},
}: {
	projects: { id: string; name: string }[];
	memoryOff: boolean;
	preparing?: boolean;
	onKeep?: () => void;
} = $props();

let review = $state<MemoryQuarantine | null>(null);
let open = $state(false);
let busy = $state(false);
let editing = $state<string | null>(null);
let draft = $state("");
let feedback = $state<"memoryReview.kept" | "memoryReview.discarded" | null>(
	null,
);
let error = $state<
	| "memoryReview.error"
	| "memoryReview.loadError"
	| "memoryReview.stale"
	| "memoryReview.off"
	| null
>(null);
let trigger = $state<HTMLButtonElement>();
let heading = $state<HTMLHeadingElement>();
let editor = $state<HTMLTextAreaElement>();
let attempt = $state.raw<MemoryQuarantineRequest | null>(null);
let writeRevision = 0;
let readRevision = 0;
let readErrors = $state(0);
const actionBlocked = $derived(
	busy ||
		error === "memoryReview.error" ||
		error === "memoryReview.stale" ||
		error === "memoryReview.off",
);
const reviewId = $props.id();

async function load(signal?: AbortSignal) {
	const revision = writeRevision;
	const request = ++readRevision;
	try {
		const next = await fetchMemoryQuarantine(signal);
		if (
			!signal?.aborted &&
			revision === writeRevision &&
			request === readRevision &&
			!busy
		) {
			const applied = next.approvals?.some(
				({ id, status }) =>
					status === "succeeded" &&
					review?.approvals?.some(
						(prior) => prior.id === id && prior.status !== "succeeded",
					),
			);
			review = next;
			readErrors = 0;
			if (applied) onKeep();
			if (error === "memoryReview.loadError") error = null;
			if (editing && !next.candidates.some(({ id }) => id === editing)) {
				editing = null;
				draft = "";
			}
		}
	} catch {
		if (
			!signal?.aborted &&
			revision === writeRevision &&
			request === readRevision &&
			!busy &&
			review
		) {
			readErrors++;
			if (!error) error = "memoryReview.loadError";
		}
	}
}

$effect(() => {
	if (memoryOff) {
		writeRevision++;
		review = null;
		open = false;
		editing = null;
		draft = "";
		attempt = null;
		error = null;
		feedback = null;
		return;
	}
	const controller = new AbortController();
	void load(controller.signal);
	return () => controller.abort();
});

$effect(() => {
	if (
		memoryOff ||
		busy ||
		(review?.status !== "working" &&
			!review?.approvals?.some(({ status }) => status === "queued"))
	)
		return;
	const controller = new AbortController();
	const timer = setTimeout(
		() => void load(controller.signal),
		Math.min(30_000, (1 + readErrors) * 3000),
	);
	return () => {
		clearTimeout(timer);
		controller.abort();
	};
});

onDestroy(() => {
	writeRevision++;
	readRevision++;
});

async function toggle() {
	open = !open;
	await tick();
	if (open) heading?.focus();
	else trigger?.focus();
}

async function beginEdit(candidate: MemoryQuarantineCandidate) {
	editing = candidate.id;
	draft = candidate.text;
	await tick();
	editor?.focus();
}

async function submit(decision: Decision) {
	if (busy || memoryOff) return;
	const same =
		attempt &&
		attempt.action === decision.action &&
		(decision.action === "start" ||
			(decision.action === "retry" &&
				attempt.action === "retry" &&
				decision.id === attempt.id) ||
			(decision.action === "resolve" &&
				attempt.action === "resolve" &&
				decision.id === attempt.id &&
				decision.decision === attempt.decision &&
				("text" in decision ? decision.text : undefined) ===
					("text" in attempt ? attempt.text : undefined)));
	const request: MemoryQuarantineRequest =
		same && attempt
			? attempt
			: decision.action === "retry"
				? decision
				: { ...decision, requestId: crypto.randomUUID() };
	attempt = request;
	busy = true;
	const revision = ++writeRevision;
	error = null;
	feedback = null;
	try {
		const next = await saveMemoryQuarantine(request);
		if (memoryOff || revision !== writeRevision) return;
		review = next;
		attempt = null;
		editing = null;
		draft = "";
		if (decision.action === "resolve") {
			feedback =
				decision.decision === "keep"
					? "memoryReview.kept"
					: "memoryReview.discarded";
			if (decision.decision === "keep") onKeep();
			await tick();
			heading?.focus();
		}
	} catch (cause) {
		if (memoryOff || revision !== writeRevision) return;
		if (cause instanceof ApiError && cause.code === "stale_memory") {
			attempt = null;
			error = "memoryReview.stale";
		} else if (cause instanceof ApiError && cause.code === "memory_off") {
			error = "memoryReview.off";
			attempt = null;
			if (review) review = { ...review, candidates: [] };
		} else error = "memoryReview.error";
	} finally {
		busy = false;
	}
}

function scopeLabel(
	candidate: MemoryQuarantineCandidate,
	personal: string,
	project: string,
) {
	const scope = candidate.scope;
	return scope.kind === "personal"
		? personal
		: (projects.find(({ id }) => id === scope.projectId)?.name ?? project);
}
</script>

<svelte:window onfocus={() => { if (!memoryOff && !busy) void load(); }} />

{#if !memoryOff && review && review.status !== "unavailable"}
	<div class="memory-notice" data-testid="memory-quarantine-notice">
		<Info size={18} strokeWidth={1.8} aria-hidden="true" />
		<div class="memory-quarantine-body">
			<button type="button" class="btn-secondary memory-button" bind:this={trigger} aria-expanded={open}
				aria-controls={open ? reviewId : undefined} onclick={() => void toggle()}>
				{open ? $t("memoryReview.hide") : $t("memoryReview.title")}
			</button>
			{#if !open && review.status === "working"}<p role="status">{$t(error === "memoryReview.loadError" ? "memoryReview.loadError" : "memoryReview.working")}</p>{/if}
			{#if open}
				<section id={reviewId} aria-labelledby={reviewId + "-title"} aria-busy={busy}>
					<h3 id={reviewId + "-title"} tabindex="-1" bind:this={heading}>{$t("memoryReview.title")}</h3>
					{#if preparing}<p>{$t("memoryReview.afterSwitch")}</p>{/if}
					{#if review.status === "idle"}
						<p>{$t("memoryReview.intro")}</p>
						<button type="button" class="btn-primary memory-button" disabled={actionBlocked} onclick={() => void submit({ action: "start" })}>{$t("memoryReview.start")}</button>
					{:else if review.status === "working"}
						<p role="status">{$t("memoryReview.working")}</p>
					{:else if review.status === "held"}
						<p role="status">{$t("memoryReview.held")}</p>
					{:else if review.status === "complete" && !review.candidates.length}
						<p role="status"><strong>{$t("memoryReview.complete")}</strong></p>
						<p>{$t("memoryReview.empty")}</p>
					{/if}
					{#if error}
						<p role="alert">{$t(error)}</p>
						{#if error === "memoryReview.error" && attempt}
							<button type="button" class="btn-secondary memory-button" disabled={busy} onclick={() => attempt && void submit(attempt)}>{$t("memoryReview.retry")}</button>
						{:else}
							<button type="button" class="btn-secondary memory-button" disabled={busy} onclick={() => { error = null; void load(); }}>{$t("memoryReview.retry")}</button>
						{/if}
					{/if}
					{#if feedback}<p role="status">{$t(feedback)}</p>{/if}
					{#if review.candidates.length}
						<p>{$t("memoryReview.pendingHelp")}</p>
						<ul class="memory-quarantine-candidates">
							{#each review.candidates as candidate (candidate.id)}
								<li>
									<div class="memory-quarantine-source">
										<span>{scopeLabel(candidate, $t("memoryNew.personal"), $t("memoryReview.unknownProject"))}</span>
										<time datetime={candidate.source.assertedAt}>{new Date(candidate.source.assertedAt).toLocaleDateString($uiLanguage)}</time>
										<a href={buildChatSourceMessageHref({ conversationId: candidate.source.conversationId, assistantMessageId: candidate.source.messageId })}>
											{$t("memoryReview.source")} <ArrowUpRight size={12} aria-hidden="true" />
										</a>
									</div>
									{#if editing === candidate.id}
										<label>
											{$t("memoryNew.statement")}
											<textarea bind:this={editor} bind:value={draft} disabled={actionBlocked} maxlength={16000} rows="3"></textarea>
										</label>
										<div class="memory-quarantine-buttons">
											<button type="button" class="btn-primary memory-button" disabled={actionBlocked || !draft.trim()} onclick={() => void submit({ action: "resolve", decision: "keep", id: candidate.id, text: draft.trim() })}>{$t("memoryReview.saveEdit")}</button>
											<button type="button" class="btn-secondary memory-button" disabled={actionBlocked} onclick={() => { editing = null; draft = ""; }} >{$t("memoryNew.cancel")}</button>
										</div>
									{:else}
										<p class="memory-quarantine-text">{candidate.text}</p>
										<div class="memory-quarantine-buttons">
											<button type="button" class="btn-primary memory-button" disabled={actionBlocked} onclick={() => void submit({ action: "resolve", decision: "keep", id: candidate.id })}>{$t("memoryReview.keep")}</button>
											<button type="button" class="btn-secondary memory-button" disabled={actionBlocked} onclick={() => void beginEdit(candidate)}>{$t("memoryReview.edit")}</button>
											<button type="button" class="btn-ghost memory-button" disabled={actionBlocked} onclick={() => void submit({ action: "resolve", decision: "discard", id: candidate.id })}>{$t("memoryReview.discard")}</button>
										</div>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
					{#if review.approvals?.length}
						<h4>{$t("memoryReview.approvals")}</h4>
						<ul class="memory-quarantine-candidates">
							{#each review.approvals as approval (approval.id)}
								<li>
									<p class="memory-quarantine-text">{approval.text}</p>
									{#if approval.status === "queued"}
										<p role="status">{$t("memoryReview.keepQueued")}</p>
									{:else if approval.status === "failed"}
										<p>{$t("memoryReview.keepFailed")}</p>
										{#if approval.retryable}
											<button type="button" class="btn-secondary memory-button" disabled={actionBlocked} onclick={() => void submit({action:"retry", id:approval.id})}>{$t("memoryReview.retryKeep")}</button>
										{/if}
									{:else}
										<p role="status">{$t(preparing ? "memoryReview.keepPrepared" : "memoryReview.keepReady")}</p>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
				</section>
			{/if}
		</div>
	</div>
{/if}

<style>
	.memory-quarantine-body {
		flex: 1;
		min-width: 0;
	}
	section {
		margin-top: 12px;
	}
	h3, h4, p {
		margin: 0 0 8px;
	}
	.memory-quarantine-candidates {
		list-style: none;
		padding: 0;
		margin: 8px 0 0;
	}
	li {
		border-top: 1px solid var(--border-default);
		padding: 12px 0;
	}
	li:last-child {
		padding-bottom: 0;
	}
	.memory-quarantine-source, .memory-quarantine-buttons {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 12px;
	}
	.memory-quarantine-source {
		color: var(--text-secondary);
	}
	.memory-quarantine-source a {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		text-decoration: underline;
	}
	.memory-quarantine-text {
		margin-top: 6px;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	textarea {
		display: block;
		width: 100%;
		margin: 4px 0 8px;
		padding: 8px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-elevated);
		color: var(--text-primary);
		resize: vertical;
	}
</style>
