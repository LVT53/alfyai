<script lang="ts">
// The App's sandboxed frame and the parent half of its storage bridge
// (Feature 2 · Artifacts, Slice 2). This is the one component that runs a
// generated app: `<iframe sandbox="allow-scripts allow-forms">`, exactly that
// string, forever (ruling 58: `allow-forms` is the one addition, so a
// generated app's <form> submit event fires — the CSP's `form-action 'none'`
// still refuses the submission itself) — see the long trust-boundary note on
// the message listener below before touching either the sandbox attribute or
// the validation order. The literal here is a plain string, not an import of
// `sandbox-response.ts`'s `APP_IFRAME_SANDBOX`: a client component cannot
// import `$lib/server/*` without breaking the build, so the two are kept in
// sync by AppFrame.test.ts asserting this literal equals that constant.
import {
	readAppValue,
	writeAppValue,
	type AppKvRefusalReason,
} from "$lib/client/api/artifacts";
import { t, type I18nKey } from "$lib/i18n";

interface Props {
	artifactId: string;
	/** Changes when a new version is written, so the frame reloads rather than rendering a stale app. */
	version: number;
	/** For the iframe's accessible title and the frame's loading/blocked copy. */
	title?: string;
	/** Widens the served route's and the kv route's scope for an incognito conversation's own App — see +server.ts. */
	conversationId?: string | null;
	/** Fires with an already-localised sentence on a storage refusal. The PARENT renders nothing extra for it (Contracts' UI-states table) — it exists for the caller's own diagnostics, not a second error banner. */
	onStorageError?: (message: string) => void;
}

let {
	artifactId,
	version,
	title = "",
	conversationId = null,
	onStorageError = undefined,
}: Props = $props();

// A ref read by the message handler: Svelte 5 runes want bind:this state
// declared with $state (AGENTS.md).
let iframe = $state<HTMLIFrameElement | null>(null);

let src = $derived(
	`/api/artifacts/${encodeURIComponent(artifactId)}/app?v=${version}` +
		(conversationId
			? `&conversationId=${encodeURIComponent(conversationId)}`
			: ""),
);

const STORAGE_ERROR_I18N_KEYS: Partial<Record<AppKvRefusalReason, I18nKey>> = {
	too_large: "artifacts.app.storage.tooLarge",
	too_many_keys: "artifacts.app.storage.tooManyKeys",
	not_serialisable: "artifacts.app.storage.notSerialisable",
};

/**
 * Rejected messages by clause, dev-only (`import.meta.env.DEV`) — a counter,
 * never a log, because a stored value can be the user's own text and must
 * never reach a log line or a console message (Contracts).
 */
export const rejectionCounts: Partial<Record<string, number>> = {};
function countRejection(clause: string): void {
	if (!import.meta.env.DEV) return;
	rejectionCounts[clause] = (rejectionCounts[clause] ?? 0) + 1;
}

function localizeRefusal(reason: AppKvRefusalReason): string | null {
	const key = STORAGE_ERROR_I18N_KEYS[reason];
	return key ? $t(key) : null;
}

/**
 * Replies to the SAME window that asked (`event.source.postMessage`), never
 * the window object nor any other target, so only the asker is answered. The
 * error text sent back is already localised where a line exists — the
 * contract's `window.alfy.storage.get/set` promises reject with
 * `new Error(reply.error)`, so a model-authored app that inspects its own
 * catch block sees real, human-readable text, not a bare reason code.
 */
function reply(
	source: Window,
	requestId: number,
	result:
		| { ok: true; value: unknown }
		| { ok: false; reason: AppKvRefusalReason },
): void {
	if (result.ok) {
		source.postMessage(
			{
				v: 1,
				kind: "alfy.storage.result",
				id: requestId,
				ok: true,
				value: result.value,
			},
			"*",
		);
		return;
	}
	const localized = localizeRefusal(result.reason);
	if (localized) onStorageError?.(localized);
	source.postMessage(
		{
			v: 1,
			kind: "alfy.storage.result",
			id: requestId,
			ok: false,
			error: localized ?? result.reason,
		},
		"*",
	);
}

/**
 * Every served call is an authenticated request to the kv route, so the frame
 * gets a bounded share of them: a few at the server at once (the rest of the
 * browser's per-host connections stay the chat's), then a backlog in arrival
 * order, sized to hold an app loading every key the store allows at start
 * (ARTIFACT_KV_MAX_KEYS, 200). A frame posting past the backlog is flooding:
 * the excess is dropped without a reply, like any other refused message, and
 * the app's own promise times out in the bootstrap.
 *
 * Ruling 58 (RV-2A open question 5): the COUNT cap above bounds how many
 * calls the backlog holds, never how large their values are — a hostile app
 * posting many large-but-serialisable values can still press on the parent
 * tab's memory well before 256 of them queue up. `MAX_CALLS_WAITING_BYTES` is
 * this slice's independent client-side ceiling on the backlog's total
 * payload size; it is NOT a copy of the server's own per-value cap
 * (`APP_KV_LIMITS`, a server-only module a client component cannot import
 * without breaking the build), just a conservative bound on what this tab is
 * willing to hold onto while a call waits its turn.
 */
const MAX_CALLS_IN_FLIGHT = 4;
const MAX_CALLS_WAITING = 256;
const MAX_CALLS_WAITING_BYTES = 8 * 1024 * 1024; // 8 MiB
let callsInFlight = 0;
let queuedBytes = 0;
const callsWaiting: Array<{ run: () => Promise<void>; bytes: number }> = [];

/**
 * A conservative, cheap estimate of one queued call's memory footprint —
 * the request's own value is the only part of a call that can be large.
 * `undefined`, a function, a `BigInt` or a cycle cannot be measured this way
 * (`JSON.stringify` returns `undefined` or throws); they count as zero here
 * rather than being refused at the gate, because `writeAppValue`'s own
 * `not_serialisable` check refuses them the moment they are dequeued
 * (finding 4) — this estimate exists for the memory a FLOOD of ordinarily
 * large values can hold, not for catching an unserialisable one.
 */
function estimateQueuedBytes(value: unknown): number {
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		return 0;
	}
}

function runWaitingCalls(): void {
	while (callsInFlight < MAX_CALLS_IN_FLIGHT) {
		const queued = callsWaiting.shift();
		if (!queued) return;
		queuedBytes -= queued.bytes;
		callsInFlight += 1;
		void queued.run().finally(() => {
			callsInFlight -= 1;
			runWaitingCalls();
		});
	}
}

/**
 * Two quick `set`s of the SAME key can otherwise land out of order: the
 * flood bound above still allows up to four calls in flight together, so a
 * slower FIRST write finishing after a faster SECOND one would let the
 * OLDER value win — exactly what a debounced slider's `input` events do
 * (RV-2A open question 5). Chaining each key's own calls onto its own
 * promise keeps that key's writes strictly in arrival order while different
 * keys still run independently under the flight cap above. `.then(run, run)`
 * (not `.then(run)`) runs the next write regardless of whether the previous
 * one succeeded or failed — one key's earlier failure must not wedge its
 * later calls forever.
 */
const pendingSetByKey = new Map<string, Promise<void>>();

function sequenceSetByKey(key: string, run: () => Promise<void>): Promise<void> {
	const previous = pendingSetByKey.get(key) ?? Promise.resolve();
	const settled = previous.then(run, run);
	pendingSetByKey.set(key, settled);
	void settled.finally(() => {
		if (pendingSetByKey.get(key) === settled) pendingSetByKey.delete(key);
	});
	return settled;
}

async function serveStorageCall(call: {
	source: Window;
	requestId: number;
	method: "get" | "set";
	artifactId: string;
	key: string;
	value: unknown;
	conversationId: string | null;
}): Promise<void> {
	if (call.method === "set") {
		await sequenceSetByKey(call.key, () => performSet(call));
		return;
	}
	await performGet(call);
}

async function performGet(call: {
	source: Window;
	requestId: number;
	artifactId: string;
	key: string;
	conversationId: string | null;
}): Promise<void> {
	try {
		reply(
			call.source,
			call.requestId,
			await readAppValue(call.artifactId, call.key, call.conversationId),
		);
	} catch {
		// The bridge's own fetch failed (network, server down): the app's
		// promise is left to the bootstrap's own 5s timeout rather than
		// answering with a guess. onStorageError still fires so the caller
		// can note it happened.
		onStorageError?.($t("artifacts.app.storage.timedOut"));
	}
}

async function performSet(call: {
	source: Window;
	requestId: number;
	artifactId: string;
	key: string;
	value: unknown;
	conversationId: string | null;
}): Promise<void> {
	try {
		const written = await writeAppValue(
			call.artifactId,
			call.key,
			call.value,
			call.conversationId,
		);
		// A set has nothing to echo back; the bootstrap's set() promise
		// resolves with undefined either way.
		reply(
			call.source,
			call.requestId,
			written.ok ? { ok: true, value: null } : written,
		);
	} catch {
		// The bridge's own fetch failed (network, server down): the app's
		// promise is left to the bootstrap's own 5s timeout rather than
		// answering with a guess. onStorageError still fires so the caller
		// can note it happened.
		onStorageError?.($t("artifacts.app.storage.timedOut"));
	}
}

/**
 * The whole trust boundary. A request is served ONLY when all five clauses
 * below hold; anything else is dropped WITHOUT a reply — the frame's own
 * bootstrap-side timeout is what a legitimate caller sees in that case, and
 * that is deliberate: an attacker gets no signal telling them which clause
 * they tripped.
 *
 *   event.source === frame.contentWindow   — stops a popup, a sibling frame,
 *                                            an opener, or an injected script
 *                                            elsewhere in the app.
 *   event.origin === "null"                — stops the frame ceasing to be
 *                                            opaque-origin (allow-same-origin
 *                                            creeping in, or a srcdoc swap).
 *   data.v === 1 && data.kind === "alfy.storage" — stops any other message
 *                                            shape being read as a storage call.
 *   typeof data.id === "number"            — stops a non-numeric reply id.
 *   one args array of length 1–2           — stops extra arguments reaching
 *                                            the server side.
 *
 * The artifact id is NEVER read from `event.data` — it is the component's
 * OWN `artifactId` prop, always. There is no code path in this function that
 * could make a message name a different artifact, a conversation, a file, or
 * a user, even if every other field were forged correctly. The prop and the
 * scope are read HERE, when the message arrives, so a call that waits in the
 * backlog is still served for the document that made it.
 */
function handleMessage(event: MessageEvent): void {
	const frame = iframe;
	if (!frame?.contentWindow) {
		countRejection("no_frame");
		return;
	}
	if (event.source !== frame.contentWindow) {
		countRejection("wrong_source");
		return;
	}
	if (event.origin !== "null") {
		countRejection("wrong_origin");
		return;
	}
	const data = event.data as Record<string, unknown> | null;
	if (!data || typeof data !== "object") {
		countRejection("not_an_object");
		return;
	}
	if (data.v !== 1 || data.kind !== "alfy.storage") {
		countRejection("wrong_kind");
		return;
	}
	if (data.method !== "get" && data.method !== "set") {
		countRejection("wrong_method");
		return;
	}
	if (typeof data.id !== "number" || !Number.isFinite(data.id)) {
		countRejection("wrong_id");
		return;
	}
	if (
		!Array.isArray(data.args) ||
		(data.args.length !== 1 && data.args.length !== 2)
	) {
		countRejection("wrong_args");
		return;
	}

	// A `set`'s value is the only part of a call that can be large; a `get`
	// carries none (args.length === 1), so it always estimates as zero here.
	const estimatedBytes =
		data.method === "set" ? estimateQueuedBytes(data.args[1]) : 0;
	if (
		callsWaiting.length >= MAX_CALLS_WAITING ||
		queuedBytes + estimatedBytes > MAX_CALLS_WAITING_BYTES
	) {
		countRejection("flood");
		return;
	}
	const call = {
		source: event.source as Window,
		requestId: data.id,
		method: data.method,
		artifactId, // THE PROP. Never event.data.artifactId — there is no such read.
		key: String(data.args[0]),
		value: data.args[1],
		conversationId,
	} as const;
	queuedBytes += estimatedBytes;
	callsWaiting.push({ run: () => serveStorageCall(call), bytes: estimatedBytes });
	runWaitingCalls();
}

$effect(() => {
	function listener(event: MessageEvent): void {
		handleMessage(event);
	}
	window.addEventListener("message", listener);
	return () => window.removeEventListener("message", listener);
});

/**
 * Ruling 58's tripwire (RV-2A open question 2). The CSP cannot stop a
 * sandboxed frame from navigating ITSELF — no `allow-top-navigation` is
 * needed for that, only for navigating the TOP page — so a hostile app can
 * still swap its own document for a fake "sign in again" form drawn inside
 * the panel. The parent cannot tell a load apart from the network response
 * alone, but it knows exactly which loads IT asked for: the initial `src`,
 * a version reload, and the `{#key src}` remount above are all the SAME
 * event from the DOM's point of view — a fresh iframe element being
 * inserted — so tracking "has THIS element's first load already happened"
 * covers all three at once with no separate counter needed. Any load after
 * that first one, on the SAME element, was not asked for: the app navigated
 * itself. It acts after the fact (the app already ran once), but it ends a
 * phishing flow before the fake form can be interacted with for long.
 */
let tripwireTripped = $state(false);

function trackFrameLoad(node: HTMLIFrameElement) {
	let expectingLoad = true;
	function onLoad(): void {
		if (expectingLoad) {
			expectingLoad = false;
			return;
		}
		// Tearing the element down (below) ends the runaway document
		// immediately; there is nothing further for it to say to the bridge.
		tripwireTripped = true;
	}
	node.addEventListener("load", onLoad);
	return {
		destroy(): void {
			node.removeEventListener("load", onLoad);
		},
	};
}

/** Re-enters the `{#if}` branch below, which mounts a brand-new iframe element (its own fresh WindowProxy and its own free first load) at the same src. */
function reloadAfterTripwire(): void {
	tripwireTripped = false;
}
</script>

<!-- One iframe ELEMENT per served document, never a navigated one. A browser
     keeps an iframe's WindowProxy for the element's whole life, so if `src`
     changed in place, the outgoing document (still running until the next one
     commits) would keep passing `event.source === frame.contentWindow`, and
     its storage calls would be served against the NEW artifact id; replies
     to its pending calls would reach the next document, whose request ids
     restart at 1. A new element per `src` gives each document its own
     WindowProxy, and removing the old element ends the old document at once. -->
{#if tripwireTripped}
	<div class="app-frame-tripwire" role="alert">
		<p>{$t('artifacts.app.frame.tripwire')}</p>
		<button
			type="button"
			class="app-frame-tripwire-reload"
			onclick={reloadAfterTripwire}
		>
			{$t('artifacts.app.frame.reload')}
		</button>
	</div>
{:else}
	{#key src}
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -- Owner decision 15: reachable by
		     keyboard even when the app's own content has nothing focusable; a user who cannot
		     click cannot otherwise use the app at all. -->
		<iframe
			bind:this={iframe}
			use:trackFrameLoad
			class="app-frame"
			sandbox="allow-scripts allow-forms"
			{src}
			title={$t('artifacts.app.frame.title', { title })}
			tabindex="0"
		></iframe>
	{/key}
{/if}

<style>
	.app-frame {
		display: block;
		width: 100%;
		height: 100%;
		border: 0;
		background: var(--surface-page);
	}

	.app-frame-tripwire {
		display: flex;
		width: 100%;
		height: 100%;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-sm);
		padding: var(--space-md, 1rem);
		text-align: center;
		color: var(--text-muted);
		font-size: var(--text-sm);
		background: var(--surface-page);
	}

	.app-frame-tripwire-reload {
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-elevated);
		padding: 0.35rem 0.7rem;
		color: var(--text-primary);
		font-size: var(--text-sm);
		cursor: pointer;
	}
</style>
