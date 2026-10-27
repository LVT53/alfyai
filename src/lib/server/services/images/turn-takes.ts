// What one chat turn has made with `make_image`: its cards and its takes, in
// memory, gone with the turn. It is the tool's own bookkeeping: how many calls
// were made, which card a repeated request belongs to, how many takes a card
// has had and which takes may still be retried. Nothing here is persisted (the
// cards and takes are rows of their own) and nothing the model writes is a key
// into it that reaches the database.

import type { TakeRequest } from "./take-request";

/** Calls to `make_image` one turn may make; the call past it is refused. */
export const MAX_IMAGE_CALLS_PER_TURN = 8;
/** Takes one card may have in one turn ("show me four"). */
export const MAX_TAKES_PER_CARD_PER_TURN = 4;

export type TurnTakeRecord = {
	takeId: string;
	cardId: string;
	cardKey: string;
	/** What the call asked for, so an identical call can be told from a different one. */
	callKey: string;
	seed: number;
	request: TakeRequest;
	/** This take was made again from an earlier one that missed. */
	isRetry: boolean;
	/** The message picture this change is made from, for the look's label; null for a new picture or a base the message did not carry. */
	baseNumber?: number | null;
	/** A retry of this take has been made (one per take). */
	retried: boolean;
};

export type TurnTakes = {
	/**
	 * Runs one planning step at a time for the turn. The AI SDK runs every tool
	 * call of a step at once, so four `make_image` calls for a new picture would
	 * each find no card, each make their own, and slip past the four-takes cap;
	 * in line, the second call finds the first's card. Waiting for a take stays
	 * outside it. A step that throws lets the next one run.
	 */
	exclusive<T>(step: () => Promise<T>): Promise<T>;
	/** This call's count, the first being 1. */
	countCall(): number;
	cardFor(cardKey: string): string | undefined;
	rememberCard(cardKey: string, cardId: string): void;
	noteTake(record: Omit<TurnTakeRecord, "retried">): void;
	/** Takes of the card this turn that count against its four: a retry takes the place of the take it repeats. */
	takesInCard(cardId: string): number;
	take(takeId: string): TurnTakeRecord | undefined;
	/** The card's first non-retry take made for this very request, if any. */
	firstTakeOfCall(cardId: string, callKey: string): TurnTakeRecord | undefined;
	markRetried(takeId: string): void;
};

export function createTurnTakes(): TurnTakes {
	let calls = 0;
	const cardByKey = new Map<string, string>();
	const takes = new Map<string, TurnTakeRecord>();
	let line: Promise<unknown> = Promise.resolve();
	return {
		exclusive: <T>(step: () => Promise<T>): Promise<T> => {
			const run = line.then(step, step);
			line = run.catch(() => undefined);
			return run;
		},
		countCall: () => {
			calls += 1;
			return calls;
		},
		cardFor: (cardKey) => cardByKey.get(cardKey),
		rememberCard: (cardKey, cardId) => {
			cardByKey.set(cardKey, cardId);
		},
		noteTake: (record) => {
			takes.set(record.takeId, { ...record, retried: false });
		},
		takesInCard: (cardId) =>
			[...takes.values()].filter(
				(record) => record.cardId === cardId && !record.isRetry,
			).length,
		take: (takeId) => takes.get(takeId),
		firstTakeOfCall: (cardId, callKey) =>
			[...takes.values()].find(
				(record) =>
					record.cardId === cardId &&
					record.callKey === callKey &&
					!record.isRetry,
			),
		markRetried: (takeId) => {
			const record = takes.get(takeId);
			if (record) record.retried = true;
		},
	};
}
