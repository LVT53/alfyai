import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '$lib/types';
import { hasForkedAssistantInRange } from './lifecycle-guards';

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
});
