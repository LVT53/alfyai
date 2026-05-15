import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '$lib/types';
import {
	FORKED_SOURCE_HISTORY_CONFIRMATION_REQUIRED_CODE,
	getForkCreationErrorKey,
	hasForkedAssistantInRange,
	isForkedSourceHistoryConfirmationRequired,
} from './lifecycle-guards';

describe('chat lifecycle guards', () => {
	it('detects forked assistant messages inside a destructive edit or regeneration range', () => {
		const messages: ChatMessage[] = [
			{
				id: 'user-1',
				role: 'user',
				content: 'Question',
				timestamp: 1,
			},
			{
				id: 'assistant-1',
				role: 'assistant',
				content: 'Forked answer',
				timestamp: 2,
				sourceForks: {
					count: 1,
					forks: [
						{
							conversationId: 'fork-1',
							title: 'Question (fork 1)',
							forkSequence: 1,
							createdAt: 3,
						},
					],
				},
			},
			{
				id: 'user-2',
				role: 'user',
				content: 'Later follow-up',
				timestamp: 4,
			},
		];

		expect(hasForkedAssistantInRange(messages, 0)).toBe(true);
		expect(hasForkedAssistantInRange(messages, 1)).toBe(true);
		expect(hasForkedAssistantInRange(messages, 2)).toBe(false);
	});

	it('maps fork creation service codes to localized i18n keys', () => {
		expect(getForkCreationErrorKey('invalid_source_message')).toBe(
			'fork.errors.invalidSourceMessage',
		);
		expect(getForkCreationErrorKey('required_generated_work_unavailable')).toBe(
			'fork.errors.requiredGeneratedWorkUnavailable',
		);
		expect(getForkCreationErrorKey('fork_sequence_conflict')).toBe(
			'fork.errors.sequenceConflict',
		);
		expect(getForkCreationErrorKey('unknown_code')).toBeNull();
	});

	it('detects stale server fork warnings from stream and API errors', () => {
		expect(
			isForkedSourceHistoryConfirmationRequired({
				code: FORKED_SOURCE_HISTORY_CONFIRMATION_REQUIRED_CODE,
			}),
		).toBe(true);
		expect(isForkedSourceHistoryConfirmationRequired(new Error('nope'))).toBe(
			false,
		);
	});
});
