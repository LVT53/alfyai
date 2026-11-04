<script lang="ts">
// "Ask me first": Alfy stopped its reply to ask the person 1 to 3 questions, and this
// is where they answer. It wears ArtifactCard's shell, like the permission card, and
// sits in the reply after the words Alfy wrote before asking.
//
// The person picks an answer, types their own words on the question's own line
// (never in the message box), leaves the choice to Alfy ("Up to you") or closes the
// card with the X. One question with one pick sends on a click; a larger card, or a
// question that takes several picks, sends on Send, which is on once every question
// has an answer. Own words replace that question's picks, and a pick clears the words.
//
// What the card knows is a question row and two flags. The page owns `busy` (an
// answer is going out) and `failed` (it did not go through), as WriteConfirmCard's
// {busy, error} are owned. The page takes an answer by setting `busy` inside `onAnswer`,
// and the card is off from then until the page lowers it, so a double tap, or Enter after
// a click, never answers twice. A page that refuses the answer (a sealed chat, an open
// edit) sets nothing, and the card stays answerable.
//
// The states, in order: waking (answers off for 400 ms after the card appears, and
// until the reply's segment is saved, so a tap meant for something else cannot answer
// it), waiting, sending (everything off, the answer still shown), failed (one plain
// line under the questions, the card still answerable), and folded once the question
// is no longer waiting: the line every finished step is drawn as. A question the
// server reads as waiting again, with its answer, comes back with its picks.
import { Check, CircleAlert, PenLine, Send, X } from "@lucide/svelte";
import { flushSync, untrack } from "svelte";
import {
	readAskLineDrafts,
	storeAskLineDrafts,
} from "$lib/client/conversation-session";
import { t } from "$lib/i18n";
import {
	ASK_LIMITS,
	type AskAnswer,
	type AskQuestion,
	type AskQuestionDto,
	checkAskAnswer,
} from "$lib/shared/ask-user";
import { buildAskFoldedItem } from "./ask-card-view";
import ToolActivityRow from "./ToolActivityRow.svelte";

let {
	question,
	busy = false,
	failed = false,
	onAnswer = undefined,
}: {
	question: AskQuestionDto;
	/** An answer is going out: everything is off, and the chosen answer stays shown. */
	busy?: boolean;
	/** The answer did not go through: the card says so and stays answerable. */
	failed?: boolean;
	onAnswer?: ((questionId: string, answer: AskAnswer) => void) | undefined;
} = $props();

// The permission sheet's read-before-answer lock (WriteConfirmSheet.svelte).
const READ_BEFORE_ANSWER_MS = 400;

// A key goes into the card's line only when nothing else is in use: no field with the
// focus (the search modal, a Document in the side panel, another question's line) and no
// dialog.
const BUSY_ELSEWHERE =
	'input, textarea, select, [contenteditable]:not([contenteditable="false"]), dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]';

const uid = $props.id();

/** What the person has done on a waiting card, per question (by its place on the card). */
type Form = {
	/** The options picked, in the order they were picked. */
	picks: number[][];
	/** What the question's own line holds. */
	words: string[];
	/** Whether the question's own line is open. */
	open: boolean[];
};

function emptyForm(questions: readonly AskQuestion[]): Form {
	return {
		picks: questions.map(() => []),
		words: questions.map(() => ""),
		open: questions.map(() => false),
	};
}

/** The card as the answer that did not go through left it: its picks, and its own words on an open line. */
function formFromAnswer(asked: AskQuestionDto): Form {
	const form = emptyForm(asked.questions);
	if (asked.answer?.kind !== "answered") return form;
	for (const [index, given] of asked.answer.answers.entries()) {
		const options = asked.questions[index]?.options.length;
		if (options === undefined) break;
		const words = given.ownWords?.trim() ?? "";
		if (words !== "") {
			form.words[index] = words;
			form.open[index] = true;
		} else {
			form.picks[index] = given.picked.filter((pick) => pick < options);
		}
	}
	return form;
}

// Read once, in a closure: the card is drawn on the server too, from the question alone.
let form = $state<Form>(untrack(() => formFromAnswer(question)));
let inputs = $state<Array<HTMLInputElement | null>>([]);
// The 400 ms have passed since the card appeared.
let readUp = $state(false);
// The page took the answer (it raised `busy` inside `onAnswer`) and has not said how it went.
let handedOver = $state(false);
let foldedOpen = $state(false);

// Primitives, so that the page reading the same question again (a new object each
// time) does not start the card over.
const waiting = $derived(question.status === "waiting");
const questionId = $derived(question.id);
const many = $derived(question.questions.length > 1);
// One question with one pick: a click on an answer sends it.
const lone = $derived(!many && question.questions[0]?.multiple !== true);
const needsSend = $derived(
	many || question.questions.some((asked) => asked.multiple === true),
);
const awake = $derived(readUp && Boolean(question.assistantMessageId));
const interactive = $derived(waiting && awake && !busy && !handedOver);
const canSend = $derived(
	checkAskAnswer(question.questions, answeredByForm()).ok,
);
// An answer that was already given and is waiting again is one that did not go through.
const showFailed = $derived(
	waiting && !busy && !handedOver && (failed || Boolean(question.answer)),
);
const cardLabel = $derived(
	many
		? $t("chat.ask.cardLabelMany", { count: question.questions.length })
		: $t("chat.ask.cardLabel"),
);

// Entering the waiting state (also the first time): the card as the answer left it, the
// lines kept for a reload, and the 400 ms. Leaving it: nothing is kept, in the card or
// in the session.
$effect(() => {
	const id = questionId;
	if (!waiting) {
		untrack(() => {
			form = emptyForm(question.questions);
			readUp = false;
			handedOver = false;
		});
		storeAskLineDrafts(id, null);
		return;
	}
	untrack(() => {
		form = formFromAnswer(question);
		for (const [key, text] of Object.entries(readAskLineDrafts(id))) {
			const index = Number(key);
			if (index >= question.questions.length) continue;
			// Typed since, so newer than any answer.
			form.words[index] = text;
			form.picks[index] = [];
			form.open[index] = true;
		}
		readUp = false;
		handedOver = false;
	});
	const timer = setTimeout(() => {
		readUp = true;
	}, READ_BEFORE_ANSWER_MS);
	return () => clearTimeout(timer);
});

// The page ended the attempt: `busy` fell (a failed answer) or `failed` rose.
let wasBusy = false;
let wasFailed = false;
$effect(() => {
	const isBusy = busy;
	const hasFailed = failed;
	untrack(() => {
		if ((wasBusy && !isBusy) || (!wasFailed && hasFailed)) handedOver = false;
		wasBusy = isBusy;
		wasFailed = hasFailed;
	});
});

// Typing goes into the card, not the message box. Capture phase on the window, so it
// comes before the composer's own listeners, and only while the card could take an answer.
$effect(() => {
	if (!interactive) return;
	window.addEventListener("keydown", takeKey, true);
	return () => window.removeEventListener("keydown", takeKey, true);
});

function hasAnswer(index: number): boolean {
	return (
		(form.picks[index]?.length ?? 0) > 0 ||
		(form.words[index] ?? "").trim() !== ""
	);
}

/** The whole card as an answer: each question's own words (trimmed), else its picks. `checkAskAnswer` says whether it is one. */
function answeredByForm() {
	return {
		kind: "answered",
		answers: question.questions.map((_, index) => {
			const words = (form.words[index] ?? "").trim();
			return words !== ""
				? { picked: [], ownWords: words }
				: { picked: [...(form.picks[index] ?? [])], ownWords: null };
		}),
	};
}

/** The one way an answer leaves the card, so the guards are in one place. */
function submit(candidate: unknown) {
	if (!interactive) return;
	const checked = checkAskAnswer(question.questions, candidate);
	if (!checked.ok) return;
	handedOver = true;
	onAnswer?.(question.id, checked.answer);
	// A page takes an answer by raising `busy` inside `onAnswer`; props are read live, so it
	// has by now. One that did not (a refusal: a sealed chat, an open edit) has nothing going
	// out and sets no flag, and `failed` may be up already, so no edge would ever come: the
	// card stays answerable.
	if (!busy) handedOver = false;
}

const sendCard = () => submit(answeredByForm());

function saveLines() {
	storeAskLineDrafts(question.id, Object.fromEntries(form.words.entries()));
}

function pickOption(index: number, optionIndex: number) {
	if (!interactive) return;
	const picked = form.picks[index] ?? [];
	form.picks[index] = question.questions[index].multiple
		? picked.includes(optionIndex)
			? picked.filter((other) => other !== optionIndex)
			: [...picked, optionIndex]
		: [optionIndex];
	// A pick takes back the words, and the line with them.
	if (form.words[index] !== "" || form.open[index]) {
		form.words[index] = "";
		form.open[index] = false;
		saveLines();
	}
	if (lone) sendCard();
}

/**
 * Opens a question's line and focuses it. `flushSync` draws the input (and binds its
 * ref) before `focus()` runs, so this works inside a keydown too: the browser types the
 * character into whatever has the focus when the keydown is over.
 */
function focusLine(index: number) {
	flushSync(() => {
		form.open[index] = true;
	});
	const line = inputs[index];
	if (!line) return;
	line.focus();
	line.setSelectionRange(line.value.length, line.value.length);
}

function typeInLine(index: number, text: string) {
	if (!interactive) return;
	form.words[index] = text;
	// Own words replace the question's picks.
	if (text.trim() !== "") form.picks[index] = [];
	saveLines();
}

function pressInLine(event: KeyboardEvent) {
	// The Enter that ends a composition is not a send (Safari reports it as keyCode 229).
	const composing = event.isComposing || event.keyCode === 229;
	if (event.key !== "Enter" || composing) return;
	event.preventDefault();
	// The words are already the question's answer. One question: they are the card's, and
	// Enter sends them. A larger card is sent with Send.
	if (!many) sendCard();
}

function isInUseElsewhere(element: EventTarget | null): boolean {
	return element instanceof Element && element.closest(BUSY_ELSEWHERE) !== null;
}

/** The question the keys go to: the only one, else the first without an answer; none when each has one. */
function questionForKeys(): number | null {
	if (!many) return 0;
	const unanswered = question.questions.findIndex(
		(_, index) => !hasAnswer(index),
	);
	return unanswered === -1 ? null : unanswered;
}

function takeKey(event: KeyboardEvent) {
	if (event.defaultPrevented || event.isComposing) return;
	// A printable character, not Space (it presses the button that has the focus).
	if (event.key.length !== 1 || event.key === " ") return;
	if (event.ctrlKey || event.metaKey || event.altKey) return;
	if (
		isInUseElsewhere(event.target) ||
		isInUseElsewhere(document.activeElement)
	) {
		return;
	}
	const index = questionForKeys();
	if (index === null) return;
	// Not preventDefault: the character the browser types next lands in the line that now
	// has the focus. Stopped, so the composer's "/" shortcut and the rest never see it.
	event.stopPropagation();
	focusLine(index);
}
</script>

{#if !waiting}
	{@const item = buildAskFoldedItem(question, $t)}
	<div class="ask-folded" data-testid="ask-folded" data-status={question.status}>
		<ToolActivityRow {item} open={foldedOpen} onToggle={() => (foldedOpen = !foldedOpen)} />
	</div>
{:else}
	<article class="ask" aria-label={cardLabel} data-testid="ask-card">
		<div class="ask-body">
			{#each question.questions as asked, index}
				{@const textId = `${uid}-q${index}`}
				<div class="q" data-testid="ask-question">
					<p class="q-text">
						{#if many}<span class="q-num" aria-hidden="true">{index + 1}</span>{/if}
						<span id={textId}>{asked.question}</span>
						{#if asked.multiple}<span class="q-hint">{$t('chat.ask.pickAny')}</span>{/if}
					</p>
					<div
						class="opts"
						role={asked.multiple || lone ? 'group' : 'radiogroup'}
						aria-labelledby={textId}
					>
						{#each asked.options as option, optionIndex}
							{@const selected = form.picks[index]?.includes(optionIndex) ?? false}
							{@const semantics = asked.multiple ? 'checkbox' : lone ? undefined : 'radio'}
							{@const noteId = `${textId}-o${optionIndex}-note`}
							<button
								type="button"
								class="opt"
								class:sel={selected}
								role={semantics}
								aria-checked={semantics ? selected : undefined}
								aria-pressed={semantics ? undefined : selected}
								aria-label={option.recommended
									? $t('chat.ask.recommendedOption', { answer: option.label })
									: option.label}
								aria-describedby={option.note ? noteId : undefined}
								disabled={!interactive}
								data-testid="ask-option"
								onclick={() => pickOption(index, optionIndex)}
							>
								{#if asked.multiple}
									<span class="box" aria-hidden="true">
										{#if selected}<Check size={11} strokeWidth={3} aria-hidden="true" />{/if}
									</span>
								{:else}
									<span class="dot" aria-hidden="true"></span>
								{/if}
								<span class="opt-main">
									<span class="opt-label">{option.label}{#if option.recommended}<span class="pick" aria-hidden="true">{$t('chat.ask.recommended')}</span>{/if}</span>
									{#if option.note}<span class="opt-note" id={noteId}>{option.note}</span>{/if}
								</span>
							</button>
						{/each}
						{#if form.open[index]}
							<div class="own-field">
								<span class="own-icon"><PenLine size={14} strokeWidth={2} aria-hidden="true" /></span>
								<input
									bind:this={inputs[index]}
									type="text"
									class="own-input"
									data-testid="ask-own-input"
									value={form.words[index]}
									maxlength={ASK_LIMITS.ownWordsChars}
									placeholder={$t('chat.ask.typeOwn')}
									aria-label={$t('chat.ask.typeOwn')}
									autocomplete="off"
									enterkeyhint={many ? 'done' : 'send'}
									disabled={!interactive}
									oninput={(event) => typeInLine(index, event.currentTarget.value)}
									onkeydown={pressInLine}
								/>
								{#if !many}
									<button
										type="button"
										class="mini-send"
										aria-label={$t('chat.ask.send')}
										disabled={!interactive || !canSend}
										data-testid="ask-line-send"
										onclick={sendCard}
									>
										<Send size={14} strokeWidth={2} aria-hidden="true" />
									</button>
								{/if}
							</div>
						{:else}
							<button
								type="button"
								class="opt own"
								disabled={!interactive}
								data-testid="ask-own-row"
								onclick={() => focusLine(index)}
							>
								<span class="own-icon"><PenLine size={14} strokeWidth={2} aria-hidden="true" /></span>
								<span class="opt-label">{$t('chat.ask.typeOwn')}</span>
							</button>
						{/if}
					</div>
				</div>
			{/each}
			{#if showFailed}
				<div class="ask-err" role="alert" data-testid="ask-error">
					<span class="ask-err-icon"><CircleAlert size={14} strokeWidth={2} aria-hidden="true" /></span>
					<span>{$t('chat.ask.sendFailed')}</span>
				</div>
			{/if}
		</div>
		<footer class="ask-foot">
			<button
				type="button"
				class="quiet"
				disabled={!interactive}
				data-testid="ask-up-to-you"
				onclick={() => submit({ kind: 'left_to_alfy' })}
			>
				{$t('chat.ask.upToYou')}
			</button>
			{#if needsSend}
				<button
					type="button"
					class="btn-send"
					disabled={!interactive || !canSend}
					data-testid="ask-send"
					onclick={sendCard}
				>
					{$t('chat.ask.send')}
				</button>
			{/if}
		</footer>
		<!-- Last in the order, so the first Tab lands on an answer and not on the way out. -->
		<button
			type="button"
			class="ask-x"
			aria-label={$t('chat.ask.close')}
			disabled={!interactive}
			data-testid="ask-close"
			onclick={() => submit({ kind: 'closed' })}
		>
			<X size={14} strokeWidth={2} aria-hidden="true" />
		</button>
	</article>
{/if}

<style>
	/* ArtifactCard's shell. Margins are the card's own, so the message only places it:
	   16px above (the mockup's .ask), none below. */
	.ask {
		position: relative;
		margin: 16px 0 0;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg, 0.5rem);
		background: var(--surface-page);
		box-shadow: var(--shadow-sm);
		overflow: hidden;
		font-family: var(--font-sans);
		font-size: var(--text-md);
		line-height: 1.5;
		color: var(--text-primary);
		/* The edge of the round and square marks: --control in the mockup. */
		--ask-control: color-mix(in srgb, var(--text-primary) 32%, transparent);
	}

	/* The folded line takes the mockup's .rec margin (its sides are the row's own). */
	.ask-folded {
		display: flex;
		flex-direction: column;
		width: 100%;
		min-width: 0;
		margin: 12px 0 2px;
		overflow: visible;
	}

	.ask-body {
		padding: 14px 14px 12px;
	}

	.q + .q {
		margin-top: 16px;
		padding-top: 14px;
		border-top: 1px solid var(--border-subtle);
	}

	.q-text {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 2px 8px;
		margin: 0 2px 10px;
		font-weight: 600;
		line-height: 1.45;
		overflow-wrap: anywhere;
	}

	/* Room for the X. */
	.q:first-child .q-text {
		padding-right: 30px;
	}

	.q-num {
		color: var(--text-muted);
		font-weight: 500;
		font-variant-numeric: tabular-nums;
	}

	.q-hint {
		color: var(--text-muted);
		font-weight: 400;
		font-size: var(--text-xs);
	}

	.opts {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.opt {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		width: 100%;
		padding: 9px 12px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-page);
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			border-color var(--duration-standard) var(--ease-out),
			opacity var(--duration-standard) var(--ease-out);
	}

	.opt:not(.sel):hover:not(:disabled) {
		background: var(--surface-elevated);
		border-color: color-mix(in srgb, var(--text-primary) 16%, transparent);
	}

	.opt.sel {
		background: var(--accent-tint);
		border-color: color-mix(in srgb, var(--accent) 45%, transparent);
	}

	.dot,
	.box {
		flex: 0 0 16px;
		width: 16px;
		height: 16px;
		margin-top: 2px;
		border: 1.5px solid var(--ask-control);
		display: grid;
		place-items: center;
	}

	.dot {
		border-radius: 50%;
	}

	.box {
		border-radius: var(--radius-sm);
		color: var(--on-accent);
	}

	.sel .dot {
		border-color: var(--accent-fill);
		background: var(--accent-fill);
		box-shadow: inset 0 0 0 3px var(--surface-page);
	}

	.sel .box {
		border-color: var(--accent-fill);
		background: var(--accent-fill);
	}

	.opt-main {
		display: flex;
		flex-direction: column;
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.opt-label {
		line-height: 1.45;
	}

	.opt-note {
		margin-top: 1px;
		color: var(--text-muted);
		font-size: var(--text-sm);
		line-height: 1.4;
	}

	.pick {
		display: inline-block;
		margin-left: 6px;
		padding: 1px 7px;
		border-radius: var(--radius-full);
		background: var(--accent-tint);
		color: var(--accent-text);
		font-size: var(--text-2xs);
		font-weight: 600;
		line-height: 1.5;
		white-space: nowrap;
		vertical-align: 1px;
	}

	.opt.own {
		align-items: center;
		color: var(--text-muted);
	}

	.own-icon {
		display: inline-flex;
		flex: none;
		margin: 0 1px;
	}

	/* The open line: an accent edge and ring. */
	.own-field {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 10px 8px 12px;
		border: 1px solid var(--accent);
		border-radius: var(--radius-md);
		background: var(--surface-page);
		box-shadow: 0 0 0 3px var(--accent-tint);
	}

	.own-field .own-icon {
		color: var(--accent);
	}

	.own-input {
		flex: 1;
		min-width: 0;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--text-primary);
		font: inherit;
		outline: none;
	}

	.own-input::placeholder {
		color: var(--text-muted);
	}

	.mini-send {
		display: grid;
		flex: none;
		place-items: center;
		width: 26px;
		height: 26px;
		padding: 0;
		border: 0;
		border-radius: var(--radius-md);
		background: var(--accent-fill);
		color: var(--on-accent);
		cursor: pointer;
	}

	.ask-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 8px 14px;
		border-top: 1px solid var(--border-subtle);
	}

	.quiet {
		margin-left: -8px;
		padding: 4px 8px;
		border: 0;
		border-radius: var(--radius-md);
		background: none;
		color: var(--text-muted);
		font: inherit;
		font-size: var(--text-sm);
		cursor: pointer;
	}

	.quiet:hover:not(:disabled) {
		background: var(--surface-elevated);
		color: var(--text-primary);
	}

	.btn-send {
		padding: 6px 14px;
		border: 0;
		border-radius: var(--radius-md);
		background: var(--accent-fill);
		color: var(--on-accent);
		font: inherit;
		font-size: var(--text-sm);
		font-weight: 600;
		cursor: pointer;
	}

	/* Not red: nothing was lost. */
	.ask-err {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		margin: 10px 2px 0;
		color: var(--warning-text);
		font-size: var(--text-sm);
		line-height: 1.45;
	}

	.ask-err-icon {
		display: inline-flex;
		flex: none;
		margin-top: 2px;
		color: var(--warning);
	}

	.ask-x {
		position: absolute;
		top: 9px;
		right: 9px;
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		padding: 0;
		border: 0;
		border-radius: var(--radius-md);
		background: none;
		color: var(--icon-muted);
		cursor: pointer;
	}

	.ask-x:hover:not(:disabled) {
		background: var(--surface-elevated);
		color: var(--text-primary);
	}

	/* Off: waking, sending, and Send until every question has an answer. */
	.ask button:disabled,
	.own-input:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.opt:focus-visible,
	.quiet:focus-visible,
	.btn-send:focus-visible,
	.mini-send:focus-visible,
	.ask-x:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	@media (max-width: 767px) {
		.ask {
			font-size: var(--text-base);
		}

		.q:first-child .q-text {
			padding-right: 36px;
		}

		.ask-x {
			top: 4px;
			right: 4px;
			width: 44px;
			height: 44px;
		}

		.opt {
			min-height: 44px;
			padding: 10px 12px;
		}

		.own-field {
			min-height: 44px;
		}

		/* 16px, or iOS zooms the page when the line gets the focus. */
		.own-input {
			font-size: 16px;
		}

		.mini-send {
			width: 32px;
			height: 32px;
		}

		.ask-foot {
			padding: 6px 14px;
		}

		/* Up to you is an answer, and Send is the card's main action: both are a thumb's size. */
		.quiet {
			min-height: 44px;
			padding: 8px;
			font-size: var(--text-md);
		}

		.btn-send {
			min-height: 44px;
		}
	}
</style>
