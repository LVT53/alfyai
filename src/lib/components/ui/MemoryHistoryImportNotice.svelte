<script lang="ts">
import { onMount } from "svelte";
import { fly } from "svelte/transition";
import { t } from "$lib/i18n";
import {
	fetchMemoryHistoryImport,
	saveMemoryHistoryImport,
	type MemoryHistoryImport,
} from "$lib/client/api/memory";
import ErrorMessage from "$lib/components/chat/ErrorMessage.svelte";
import DialogShell from "./DialogShell.svelte";
import { MOTION_DURATION, reducedMotionAware } from "$lib/utils/motion";
let { profile = false, held = false }: { profile?: boolean; held?: boolean } =
	$props();
let historyState = $state<MemoryHistoryImport | null>(null);
let busy = $state(false);
let error = $state("");
let editor = $state(false);
let dismissed = $state(false);
let alive = false;
let requestId = "";
let pendingChoice: "include" | "decline" | null = null;
let loadSequence = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let channel: BroadcastChannel | undefined;
const enter = reducedMotionAware(fly);
function schedule() {
	clearTimeout(timer);
	if (alive && ["pending", "working"].includes(historyState?.status ?? ""))
		timer = setTimeout(() => void load(), 3000);
}
async function load() {
	const seq = ++loadSequence;
	try {
		const next = await fetchMemoryHistoryImport();
		if (alive && seq === loadSequence) {
			historyState = next;
			if (!profile && !next.shouldPrompt) {
				editor = false;
				pendingChoice = null;
			}
			error = "";
			schedule();
		}
	} catch {
		if (profile && alive && seq === loadSequence)
			error = $t("memoryImport.loadingFailed");
	}
}
function broadcast() {
	window.dispatchEvent(new Event("memory-history-choice"));
	if (typeof BroadcastChannel !== "undefined") {
		const publisher = new BroadcastChannel("alfyai-memory-history-choice");
		publisher.postMessage("changed");
		publisher.close();
	}
}
async function save(choice: "include" | "decline") {
	if (busy) return;
	if (!profile && choice === "decline") {
		editor = false;
		dismissed = true;
	}
	if (pendingChoice !== choice) {
		pendingChoice = choice;
		requestId = crypto.randomUUID();
	}
	busy = true;
	error = "";
	++loadSequence;
	try {
		const next = await saveMemoryHistoryImport(choice, requestId);
		broadcast();
		if (alive) {
			historyState = next;
			editor = false;
			pendingChoice = null;
			schedule();
		}
	} catch {
		if (alive) error = $t("memoryImport.failed");
	} finally {
		if (alive) busy = false;
	}
}
function closeEditor() {
	if (busy) return;
	if (profile) editor = false;
	else void save("decline");
}
onMount(() => {
	alive = true;
	void load();
	window.addEventListener("memory-history-choice", load);
	window.addEventListener("focus", load);
	if (typeof BroadcastChannel !== "undefined") {
		channel = new BroadcastChannel("alfyai-memory-history-choice");
		channel.onmessage = () => void load();
	}
	return () => {
		alive = false;
		++loadSequence;
		clearTimeout(timer);
		channel?.close();
		window.removeEventListener("memory-history-choice", load);
		window.removeEventListener("focus", load);
	};
});
</script>
{#if profile&&historyState?.available}
 <div class="history-profile" data-testid="memory-history-profile"><div><p class="history-label">{$t('memoryImport.profileTitle')}</p><p class="history-help">{$t('memoryImport.profileHelp')}</p>{#if historyState.choice}<p class="history-help">{$t(historyState.choice==='include'?'memoryImport.included':'memoryImport.declined')}</p>{/if}{#if historyState.status==='pending'}<p class="history-help" role="status">{$t('memoryImport.statusPending')}</p>{:else if historyState.status==='working'}<p class="history-help" role="status">{$t('memoryImport.statusWorking')}</p>{:else if historyState.status==='held'}<p class="history-help" role="status">{$t('memoryImport.statusHeld')}</p>{:else if historyState.status==='failed'}<p class="history-help" role="status">{$t('memoryImport.statusFailed')}</p>{:else if historyState.status==='complete'}<p class="history-help" role="status">{$t('memoryImport.statusComplete')}</p>{/if}</div><button type="button" class="btn-ghost" onclick={()=>editor=true}>{$t('memoryImport.change')}</button></div>
{:else if !profile&&historyState?.shouldPrompt&&!held&&!dismissed}
 <section class="history-notice" aria-label={$t('memoryImport.title')} data-testid="memory-history-notice" in:enter={{y:-8,duration:MOTION_DURATION.standard}}><div><h2>{$t('memoryImport.title')}</h2><p>{$t('memoryImport.later')}</p></div><div class="history-actions"><button type="button" class="btn-secondary" disabled={busy} onclick={()=>void save('decline')}>{$t('memoryImport.decline')}</button><button type="button" class="btn-primary" disabled={busy} onclick={()=>editor=true}>{$t('memoryImport.change')}</button></div></section>
{/if}
{#if error&&!editor}<ErrorMessage {error} canRetry={true} onRetry={()=>pendingChoice?void save(pendingChoice):void load()} onClose={()=>error=''}/>{/if}
{#if editor}<DialogShell title={$t('memoryImport.title')} description={$t('memoryImport.help')} onClose={closeEditor}>{#if error}<ErrorMessage {error} canRetry={!busy} onRetry={()=>pendingChoice&&void save(pendingChoice)} onClose={()=>error=''}/>{/if}<p class="history-help">{$t('memoryImport.later')}</p><div class="history-actions"><button type="button" class="btn-secondary" disabled={busy} onclick={()=>void save('decline')}>{$t('memoryImport.decline')}</button><button type="button" class="btn-primary" disabled={busy} onclick={()=>void save('include')}>{$t('memoryImport.include')}</button></div></DialogShell>{/if}
<style>
.history-profile{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 0;border-bottom:1px solid var(--border-default)}.history-label{font-size:14px;font-weight:500;margin:0}.history-help{font-size:13px;line-height:1.6;color:var(--text-muted);margin:5px 0 0}.history-notice{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 18px;margin:12px 20px;border:1px solid var(--border-default);border-radius:var(--radius-lg);background:var(--surface-elevated);box-shadow:var(--shadow-sm);font-family:var(--font-sans)}.history-notice h2{font-size:15px;font-weight:500;margin:0;line-height:1.5}.history-notice p{font-size:13px;color:var(--text-muted);margin:4px 0 0}.history-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:12px}.history-notice .history-actions{margin-top:0;flex-shrink:0}.history-actions button{font-size:13px}.history-profile button{flex-shrink:0;font-size:13px}@media(max-width:640px){.history-notice{flex-direction:column;align-items:stretch}.history-profile{flex-wrap:wrap}.history-actions{justify-content:flex-start}}
</style>
