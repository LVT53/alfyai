import { expect, test, type Page } from '@playwright/test';
import { login, openConversationComposer } from './helpers';

async function setComposerCommandRegistry(page: Page, enabled: boolean) {
	const response = await page.evaluate(async (nextEnabled) => {
		const result = await fetch('/api/admin/config', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				COMPOSER_COMMAND_REGISTRY_ENABLED: String(nextEnabled),
			}),
		});
		return { ok: result.ok, status: result.status };
	}, enabled);
	expect(response.ok, `Failed to set composer flag: ${response.status}`).toBe(true);
}

async function createEmptyConversation(page: Page): Promise<string> {
	const conversation = await page.evaluate(async () => {
		const result = await fetch('/api/conversations', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Composer Command V1 E2E' }),
		});
		if (!result.ok) {
			throw new Error(`Failed to create conversation: ${result.status}`);
		}
		return (await result.json()) as { id: string };
	});
	return conversation.id;
}

async function typeComposerCommand(page: Page, command: string) {
	const input = page.getByTestId('message-input');
	await input.fill('');
	await input.click();
	await input.pressSequentially(command);
}

async function mockComposerCommandRoutes(page: Page, capture: { streamBody?: Record<string, unknown> }) {
	await page.route('**/api/skills/discovery**', async (route) => {
		await route.fulfill({
			status: 200,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				skills: [
					{
						id: 'skill-interview',
						ownership: 'user',
						displayName: 'Interview coach',
						description: 'Practice interview answers.',
						activationExamples: ['interview me'],
						enabled: true,
						durationPolicy: 'session',
						questionPolicy: 'ask_when_needed',
						notesPolicy: 'none',
						sourceScope: 'selected_sources_only',
						creationSource: 'user_created',
						version: 1,
						createdAt: 1,
						updatedAt: 1,
					},
				],
			}),
		});
	});

	await page.route('**/api/knowledge', async (route) => {
		if (route.request().method() !== 'GET') {
			await route.continue();
			return;
		}
		await route.fulfill({
			status: 200,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				documents: [
					{
						id: 'display-alpha',
						displayArtifactId: 'display-alpha',
						promptArtifactId: 'prompt-alpha',
						familyArtifactIds: ['display-alpha', 'prompt-alpha'],
						name: 'Alpha source.md',
						mimeType: 'text/markdown',
						sizeBytes: 120,
						conversationId: null,
						summary: 'Alpha source',
						normalizedAvailable: true,
						documentOrigin: 'uploaded',
						createdAt: 1,
						updatedAt: 1,
					},
					{
						id: 'display-beta',
						displayArtifactId: 'display-beta',
						promptArtifactId: 'prompt-beta',
						familyArtifactIds: ['display-beta', 'prompt-beta'],
						name: 'Beta source.pdf',
						mimeType: 'application/pdf',
						sizeBytes: 240,
						conversationId: null,
						summary: 'Beta source',
						normalizedAvailable: true,
						documentOrigin: 'generated',
						createdAt: 2,
						updatedAt: 2,
					},
				],
				results: [],
				workflows: [],
			}),
		});
	});

	await page.route('**/api/knowledge/upload', async (route) => {
		await route.fulfill({
			status: 200,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				artifact: {
					id: 'artifact-uploaded',
					type: 'source_document',
					retrievalClass: 'durable',
					name: 'brief.txt',
					mimeType: 'text/plain',
					sizeBytes: 12,
					conversationId: 'conv-e2e',
					summary: 'Uploaded brief',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
				promptReady: true,
				promptArtifactId: 'prompt-uploaded',
				readinessError: null,
			}),
		});
	});

	await page.route('**/api/conversations/**/skill-sessions', async (route) => {
		await route.fulfill({
			status: 200,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				activeSkillSession: {
					id: 'session-e2e',
					userId: 'user-e2e',
					conversationId: 'conv-e2e',
					skillId: 'skill-interview',
					skillOwnership: 'user',
					status: 'active',
					pauseReason: null,
					endReason: null,
					skillDisplayName: 'Interview coach',
					skillDescription: 'Practice interview answers.',
					activationExamples: ['interview me'],
					durationPolicy: 'session',
					questionPolicy: 'ask_when_needed',
					notesPolicy: 'none',
					sourceScope: 'selected_sources_only',
					skillVersion: 1,
					startedFrom: 'pending_skill',
					startedAt: Date.now(),
					updatedAt: Date.now(),
					pausedAt: null,
					endedAt: null,
					milestones: [],
				},
			}),
		});
	});

	await page.route('**/api/chat/stream', async (route) => {
		capture.streamBody = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
		await route.fulfill({
			status: 200,
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
			},
			body: 'event: token\ndata: {"text":"Mixed command response"}\n\nevent: end\ndata: {}\n\n',
		});
	});
}

test.describe('Composer Command V1', () => {
	test('feature flag off hides the command tray and blocks skill discovery', async ({ page }) => {
		await login(page);
		await setComposerCommandRegistry(page, false);
		await page.goto('/', { waitUntil: 'domcontentloaded' });
		await openConversationComposer(page);

		await page.getByTestId('message-input').fill('/');
		await expect(page.getByRole('listbox', { name: 'Composer commands' })).toBeHidden();

		const discovery = await page.evaluate(async () => {
			const result = await fetch('/api/composer-commands');
			return { status: result.status, body: await result.json() };
		});
		expect(discovery.status).toBe(404);
		expect(discovery.body).toMatchObject({ errorKey: 'composerCommandRegistry.disabled' });
	});

	test('landing command trigger opens the tray without creating a draft conversation', async ({ page }) => {
		await login(page);
		await setComposerCommandRegistry(page, true);
		let createConversationAttempts = 0;
		await page.route('**/api/conversations', async (route) => {
			if (route.request().method() === 'POST') {
				createConversationAttempts += 1;
				await route.fulfill({
					status: 404,
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ error: 'unexpected create conversation' }),
				});
				return;
			}
			await route.continue();
		});
		await page.goto('/', { waitUntil: 'domcontentloaded' });
		await openConversationComposer(page);

		await typeComposerCommand(page, '/');
		await expect(page.getByRole('listbox', { name: 'Composer commands' })).toBeVisible();
		expect(createConversationAttempts).toBe(0);

		await typeComposerCommand(page, '$');
		await expect(page.getByRole('listbox', { name: 'Composer commands' })).toBeVisible();
		expect(createConversationAttempts).toBe(0);
	});

	test('mixes skill, linked sources, upload, and thinking mode in one normal chat turn', async ({ page }) => {
		const capture: { streamBody?: Record<string, unknown> } = {};

		await login(page);
		await setComposerCommandRegistry(page, true);
		await mockComposerCommandRoutes(page, capture);
		const conversationId = await createEmptyConversation(page);
		await page.goto(`/chat/${conversationId}`, { waitUntil: 'domcontentloaded' });
		await page.waitForLoadState('networkidle');
		await expect(page.getByTestId('message-input')).toBeVisible();

		const input = page.getByTestId('message-input');

		await typeComposerCommand(page, '$interview');
		await page.getByRole('option', { name: /Interview coach/i }).click();
		await expect(page.getByRole('button', { name: 'Remove pending skill Interview coach' })).toBeVisible();

		await typeComposerCommand(page, '/document');
		await page.getByRole('option', { name: /\/document/i }).click();
		const picker = page.getByRole('dialog', { name: 'Link Library documents' });
		await expect(picker).toBeVisible();
		await picker.getByRole('checkbox', { name: 'Alpha source.md' }).check();
		await picker.getByRole('checkbox', { name: 'Beta source.pdf' }).check();
		await page.getByRole('button', { name: 'Link selected documents' }).click();
		await expect(page.getByText('Alpha source.md')).toBeVisible();
		await expect(page.getByText('Beta source.pdf')).toBeVisible();

		await typeComposerCommand(page, '/thinking');
		await page.getByRole('option', { name: /\/thinking/i }).click();
		await page.getByRole('option', { name: 'Off' }).click();

		await typeComposerCommand(page, '/attach');
		await page.getByRole('option', { name: /\/attach/i }).click();
		await page.locator('input[type="file"]').setInputFiles({
			name: 'brief.txt',
			mimeType: 'text/plain',
			buffer: Buffer.from('brief text'),
		});
		await expect(page.getByText('brief.txt')).toBeVisible();

		await input.fill('Use every selected composer command in normal chat.');
		await page.getByTestId('send-button').click();

		await expect(page.getByTestId('assistant-message').first()).toContainText('Mixed command response', {
			timeout: 15000,
		});
		await expect.poll(() => capture.streamBody).toBeTruthy();
		expect(capture.streamBody).toMatchObject({
			message: 'Use every selected composer command in normal chat.',
			attachmentIds: ['artifact-uploaded'],
			thinkingMode: 'off',
			pendingSkill: {
				id: 'skill-interview',
				ownership: 'user',
				displayName: 'Interview coach',
			},
		});
		expect(capture.streamBody?.linkedSources).toEqual([
			expect.objectContaining({
				displayArtifactId: 'display-alpha',
				promptArtifactId: 'prompt-alpha',
				name: 'Alpha source.md',
			}),
			expect.objectContaining({
				displayArtifactId: 'display-beta',
				promptArtifactId: 'prompt-beta',
				name: 'Beta source.pdf',
			}),
		]);
	});

	test('mobile tray stays above the composer with reduced motion', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await login(page);
		await setComposerCommandRegistry(page, true);
		await page.route('**/api/chat/stream', async (route) => {
			await route.fulfill({
				status: 200,
				headers: {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
				},
				body: 'event: token\ndata: {"text":"Ready"}\n\nevent: end\ndata: {}\n\n',
			});
		});
		const conversationId = await createEmptyConversation(page);
		await page.goto(`/chat/${conversationId}`, { waitUntil: 'domcontentloaded' });
		await expect(page.getByTestId('message-input')).toBeVisible();
		await expect
			.poll(async () =>
				page.evaluate(async () => {
					const result = await fetch('/api/composer-commands');
					return result.status;
				})
			)
			.toBe(200);
		const closeSidebar = page.getByRole('button', { name: 'Close sidebar' });
		if (await closeSidebar.isVisible().catch(() => false)) {
			await closeSidebar.evaluate((element) => {
				(element as HTMLButtonElement).click();
			});
		}

		await typeComposerCommand(page, '/');
		await expect(page.getByTestId('message-input')).toHaveValue('/');
		const tray = page.getByRole('listbox', { name: 'Composer commands' });
		await expect(tray).toBeVisible();

		const trayBox = await tray.boundingBox();
		const composerBox = await page.locator('.message-composer').boundingBox();
		expect(trayBox).not.toBeNull();
		expect(composerBox).not.toBeNull();
		expect(trayBox!.y + trayBox!.height).toBeLessThanOrEqual(composerBox!.y + 4);

		await page.keyboard.press('Escape');
		await expect(tray).toBeHidden();
	});
});
