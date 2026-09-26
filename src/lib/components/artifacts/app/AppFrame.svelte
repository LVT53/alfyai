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
 */
const MAX_CALLS_IN_FLIGHT = 4;
const MAX_CALLS_WAITING = 256;
let callsInFlight = 0;
const callsWaiting: Array<() => Promise<void>> = [];

function runWaitingCalls(): void {
	while (callsInFlight < MAX_CALLS_IN_FLIGHT) {
		const call = callsWaiting.shift();
		if (!call) return;
		callsInFlight += 1;
		void call().finally(() => {
			callsInFlight -= 1;
			runWaitingCalls();
		});
	}
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
	try {
		if (call.method === "get") {
			reply(
				call.source,
				call.requestId,
				await readAppValue(call.artifactId, call.key, call.conversationId),
			);
			return;
		}
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

	if (callsWaiting.length >= MAX_CALLS_WAITING) {
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
	callsWaiting.push(() => serveStorageCall(call));
	runWaitingCalls();
}

$effect(() => {
	function listener(event: MessageEvent): void {
		handleMessage(event);
	}
	window.addEventListener("message", listener);
	return () => window.removeEventListener("message", listener);
});
</script>

<!-- One iframe ELEMENT per served document, never a navigated one. A browser
     keeps an iframe's WindowProxy for the element's whole life, so if `src`
     changed in place, the outgoing document (still running until the next one
     commits) would keep passing `event.source === frame.contentWindow`, and
     its storage calls would be served against the NEW artifact id; replies
     to its pending calls would reach the next document, whose request ids
     restart at 1. A new element per `src` gives each document its own
     WindowProxy, and removing the old element ends the old document at once. -->
{#key src}
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -- Owner decision 15: reachable by
	     keyboard even when the app's own content has nothing focusable; a user who cannot
	     click cannot otherwise use the app at all. -->
	<iframe
		bind:this={iframe}
		class="app-frame"
		sandbox="allow-scripts allow-forms"
		{src}
		title={$t('artifacts.app.frame.title', { title })}
		tabindex="0"
	></iframe>
{/key}

<style>
	.app-frame {
		display: block;
		width: 100%;
		height: 100%;
		border: 0;
		background: var(--surface-page);
	}
</style>
