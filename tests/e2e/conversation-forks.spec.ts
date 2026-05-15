import { expect, test, type Page } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { login, sendMessage } from './helpers';
import { db } from '../../src/lib/server/db';
import { users } from '../../src/lib/server/db/schema';
import { createConversation } from '../../src/lib/server/services/conversations';
import { createMessage } from '../../src/lib/server/services/messages';

async function seedPersistedConversation() {
	const [user] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, 'admin@local'))
		.limit(1);
	expect(user?.id).toBeTruthy();

	const source = await createConversation(user!.id, `Fork smoke ${Date.now()}`);
	await createMessage(source.id, 'user', 'Original fork question');
	const assistant = await createMessage(source.id, 'assistant', 'Persisted answer to fork.');

	return { source, assistant };
}

async function mockForkLocalStream(page: Page, text: string) {
	await page.route('**/api/chat/stream', async (route) => {
		const chunks = text
			.split(' ')
			.map((word, index, words) =>
				`event: token\ndata: ${JSON.stringify({ text: word + (index < words.length - 1 ? ' ' : '') })}\n\n`
			);
		chunks.push('event: end\ndata: {}\n\n');
		await route.fulfill({
			status: 200,
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
			},
			body: chunks.join(''),
		});
	});
}

test.describe('conversation forks', () => {
	test('forks a persisted response and keeps lineage usable across navigation and refresh', async ({ page }) => {
		await login(page);
		const { source, assistant } = await seedPersistedConversation();

		await page.goto(`/chat/${source.id}`, { waitUntil: 'domcontentloaded' });
		const assistantMessage = page.locator(`[data-message-id="${assistant.id}"]`);
		await expect(assistantMessage).toContainText('Persisted answer to fork.');

		await assistantMessage.hover();
		await page.getByRole('button', { name: 'Fork from here' }).click();
		await page.waitForURL((url) => {
			const conversationId = url.pathname.match(/^\/chat\/([^/]+)$/)?.[1];
			return Boolean(conversationId && conversationId !== source.id);
		}, { timeout: 15000 });
		const forkUrl = page.url();
		const forkId = forkUrl.match(/\/chat\/([^/?#]+)/)?.[1] ?? '';
		expect(forkId).not.toBe(source.id);

		await expect(page.locator('[data-fork-opening="true"]')).toBeVisible();
		await expect(page.getByTestId('fork-boundary-marker')).toContainText('Fork starts here');
		await expect(page.getByRole('link', { name: /Open source conversation/ })).toHaveAttribute(
			'href',
			`/chat/${source.id}#message-${assistant.id}`,
		);

		await page.reload({ waitUntil: 'domcontentloaded' });
		await expect(page.getByTestId('fork-boundary-marker')).toContainText('Copied from');
		await expect(page.locator(`[data-conversation-id="${forkId}"]`).getByLabel(/Fork of Fork smoke/)).toBeVisible();
		await page.setViewportSize({ width: 390, height: 844 });
		await expect(page.getByTestId('fork-boundary-marker')).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
		await page.setViewportSize({ width: 1280, height: 720 });

		await page.getByRole('link', { name: /Open source conversation/ }).click();
		await expect(page).toHaveURL(new RegExp(`/chat/${source.id}`));
		await expect(page.getByTestId('fork-origin-marker')).toContainText('Forked from this response');
		await expect(page.getByRole('link', { name: /Open fork/ })).toHaveAttribute('href', `/chat/${forkId}`);

		await page.goto(forkUrl, { waitUntil: 'domcontentloaded' });
		await mockForkLocalStream(page, 'Fork local continuation response.');
		await sendMessage(page, 'Continue inside the fork');
		await expect(page.getByTestId('assistant-message').last()).toContainText(
			'Fork local continuation response.',
			{ timeout: 15000 },
		);

		const deleteResult = await page.evaluate(async (sourceConversationId) => {
			const response = await fetch(`/api/conversations/${sourceConversationId}`, {
				method: 'DELETE',
			});
			return { ok: response.ok, status: response.status };
		}, source.id);
		expect(deleteResult.ok, `source delete failed with ${deleteResult.status}`).toBe(true);

		await page.goto(forkUrl, { waitUntil: 'domcontentloaded' });
		await expect(page.getByTestId('fork-boundary-marker')).toContainText(
			'Source conversation unavailable',
		);
		await expect(page.getByRole('link', { name: /Open source conversation/ })).toHaveCount(0);
	});
});
