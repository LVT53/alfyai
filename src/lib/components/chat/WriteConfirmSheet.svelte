<script lang="ts">
// On a phone a decision starts at the thumb: the conversation's pending writes
// are raised in ONE bottom sheet, one at a time, oldest first, and each answer
// moves on to the next. A reply that proposed three used to raise three sheets
// on top of each other, with three shadows over the page and only the last one
// readable, because each card raised its own.
//
// It waits for the turn: nothing rises over a reply that is still being written.
// Backing out (the grabber, a tap on the page) is not a decision. Every write
// stays pending and stays on its card in the reply, and only a new one raises
// the sheet again.
//
// Each question brings its buttons up under a thumb that may still be tapping,
// so they stay off for a moment: a double tap on "Save" must not also answer the
// delete that came up behind it.
import { onMount } from "svelte";
import DialogShell from "$lib/components/ui/DialogShell.svelte";
import { t } from "$lib/i18n";
import type { PendingWrite } from "$lib/server/services/connections/pending-write-dto";
import { uiLanguage } from "$lib/stores/settings";
import {
	isPhoneViewport,
	watchPhoneViewport,
} from "$lib/utils/viewport.svelte";
import WriteConfirmActions from "./WriteConfirmActions.svelte";
import WriteConfirmContent from "./WriteConfirmContent.svelte";
import { buildWriteCardView } from "./write-card-view";

let {
	writes,
	held = false,
	actionState = {},
	onConfirm = undefined,
	onCancel = undefined,
}: {
	writes: PendingWrite[];
	held?: boolean;
	actionState?: Record<string, { busy?: boolean; error?: string | null }>;
	onConfirm?: ((id: string) => void | Promise<void>) | undefined;
	onCancel?: ((id: string) => void | Promise<void>) | undefined;
} = $props();

let isPhone = $state(isPhoneViewport());
let backedOutOf = $state<string[]>([]);

onMount(() => watchPhoneViewport((phone) => (isPhone = phone)));

const queue = $derived(
	writes.filter(
		(write) => write.status === "pending" && !backedOutOf.includes(write.id),
	),
);
const current = $derived(queue[0] ?? null);
const view = $derived(
	current ? buildWriteCardView(current, $t, $uiLanguage) : null,
);
const waiting = $derived(queue.length - 1);
const currentId = $derived(current?.id ?? null);

const READ_BEFORE_ANSWER_MS = 400;
let readingNewQuestion = $state(false);

$effect(() => {
	if (!currentId) return;
	readingNewQuestion = true;
	const timer = setTimeout(() => {
		readingNewQuestion = false;
	}, READ_BEFORE_ANSWER_MS);
	return () => clearTimeout(timer);
});

function backOut() {
	backedOutOf = [...backedOutOf, ...queue.map((write) => write.id)];
}
</script>

{#if isPhone && !held && current && view}
	{@const state = actionState[current.id] ?? {}}
	{#snippet actions()}
		<WriteConfirmActions
			{view}
			busy={Boolean(state.busy)}
			locked={readingNewQuestion}
			onApprove={() => onConfirm?.(current.id)}
			onDecline={() => onCancel?.(current.id)}
		/>
	{/snippet}
	<DialogShell
		title={$t('connections.writeConfirm.cardLabel', { title: view.subject })}
		onClose={backOut}
		phonePresentation="sheet"
		titleVisuallyHidden
		footer={actions}
	>
		<div data-testid="write-confirm-sheet">
			{#key current.id}
				<WriteConfirmContent
					{view}
					provider={current.provider}
					error={state.error ?? null}
					footnote={waiting > 0
						? $t('connections.writeConfirm.moreWaiting', { count: waiting })
						: null}
				/>
			{/key}
		</div>
	</DialogShell>
{/if}
