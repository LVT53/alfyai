import { test, expect, type Page } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { db } from '../../src/lib/server/db';
import { users } from '../../src/lib/server/db/schema';
import { createConversation as createServerConversation } from '../../src/lib/server/services/conversations';
import { createMessage } from '../../src/lib/server/services/messages';
import { login, createConversation, ensureSidebarExpanded } from './helpers';

/**
 * Trigger visibilitychange event to simulate tab becoming visible
 */
async function triggerVisibilityChange(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      writable: true,
      configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/**
 * Trigger window focus event
 */
async function triggerWindowFocus(page: Page) {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
  });
}

/**
 * Get the count of conversations in the sidebar
 */
async function getConversationCount(page: Page): Promise<number> {
  return page.getByTestId('conversation-item').count();
}

async function waitPastRefreshDebounce(page: Page) {
  await page.waitForTimeout(2100);
}

async function expectConversationVisible(page: Page, conversationId: string) {
  await expect(page.locator(`[data-conversation-id="${conversationId}"]`)).toBeVisible({
    timeout: 10000,
  });
}

async function waitForConversationRefreshResponse(page: Page, conversationId: string) {
  const response = await page.waitForResponse(
    (candidate) =>
      candidate.url().endsWith('/api/conversations') &&
      candidate.request().method() === 'GET',
    { timeout: 10000 }
  );
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { conversations?: Array<{ id: string }> };
  expect(body.conversations?.some((conversation) => conversation.id === conversationId)).toBe(true);
}

async function deleteConversationViaApi(page: Page, conversationId: string) {
  const result = await page.evaluate(async (id) => {
    const response = await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
    return { ok: response.ok, status: response.status };
  }, conversationId);
  expect(result.ok, `conversation delete failed with status ${result.status}`).toBe(true);
}

async function seedListableConversation(title: string): Promise<string> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'admin@local'))
    .limit(1);
  expect(user?.id).toBeTruthy();
  if (!user) throw new Error('Test admin user is missing');

  const conversation = await createServerConversation(user.id, title);
  await createMessage(conversation.id, 'user', `${title} body`);
  return conversation.id;
}

test.describe('Conversation list refresh on tab/window focus', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('refreshes conversation list when tab becomes visible', async ({ page }) => {
    // Create initial conversation
    await createConversation(page, 'Initial conversation for refresh test');
    await ensureSidebarExpanded(page);

    // Get initial count
    const initialCount = await getConversationCount(page);
    expect(initialCount).toBeGreaterThanOrEqual(1);

    // Create a second conversation in a different browser context
    const secondTitle = 'Second conversation from another context';
    const secondConversationId = await seedListableConversation(secondTitle);
    await waitPastRefreshDebounce(page);

    // Trigger visibility change on first page
    const refreshResponse = waitForConversationRefreshResponse(page, secondConversationId);
    await page.bringToFront();
    await triggerVisibilityChange(page);
    await refreshResponse;

    await expectConversationVisible(page, secondConversationId);

  });

  test('refreshes conversation list on window focus', async ({ page }) => {
    // Create initial conversation
    await createConversation(page, 'Initial conversation for focus test');
    await ensureSidebarExpanded(page);

    // Get initial count
    const initialCount = await getConversationCount(page);
    expect(initialCount).toBeGreaterThanOrEqual(1);

    // Create a second conversation in a different browser context
    const secondTitle = 'Second conversation from focus context';
    const secondConversationId = await seedListableConversation(secondTitle);
    await waitPastRefreshDebounce(page);

    // Trigger window focus on first page
    const refreshResponse = waitForConversationRefreshResponse(page, secondConversationId);
    await page.bringToFront();
    await triggerWindowFocus(page);
    await refreshResponse;

    await expectConversationVisible(page, secondConversationId);

  });

  test('debounce prevents refresh more than once per 2 seconds', async ({ page }) => {
    // Create initial conversation
    await createConversation(page, 'Debounce test conversation');
    await ensureSidebarExpanded(page);

    // Track API calls
    let apiCallCount = 0;
    await page.route('**/api/conversations', async (route) => {
      apiCallCount++;
      await route.continue();
    });

    // Trigger multiple visibility changes rapidly
    await triggerVisibilityChange(page);
    await triggerVisibilityChange(page);
    await triggerVisibilityChange(page);

    // Wait a bit
    await page.waitForTimeout(500);

    // Should only have made 1 API call due to debounce
    expect(apiCallCount).toBeLessThanOrEqual(1);
  });

  test('preserves existing list on fetch failure', async ({ page }) => {
    // Create initial conversation
    await createConversation(page, 'Failure preservation test');
    await ensureSidebarExpanded(page);

    // Get initial count and conversation titles
    const initialCount = await getConversationCount(page);
    expect(initialCount).toBeGreaterThanOrEqual(1);

    // Intercept API to return error
    await page.route('**/api/conversations', async (route) => {
      await route.fulfill({
        status: 500,
        body: 'Internal Server Error',
      });
    });

    // Trigger refresh
    await triggerVisibilityChange(page);
    await page.waitForTimeout(1000);

    // Verify conversation count is preserved (not cleared)
    const countAfterError = await getConversationCount(page);
    expect(countAfterError).toBe(initialCount);
  });

  test('redirects to landing when current conversation is deleted from another device', async ({ page, context }) => {
    // Create a conversation
    const conversationId = await createConversation(page, 'Conversation to be deleted');
    await ensureSidebarExpanded(page);

    // Verify we're on the chat page
    await expect(page).toHaveURL(/\/chat\//);

    // Delete the conversation from another context
    const page2 = await context.newPage();
    await login(page2);
    await deleteConversationViaApi(page2, conversationId);
    await waitPastRefreshDebounce(page);

    // Trigger refresh on first page
    await triggerVisibilityChange(page);

    // Verify redirected to landing page
    await expect(page).toHaveURL('/', { timeout: 10000 });

    await page2.close();
  });

  test('preserves sidebar scroll position during refresh', async ({ page }) => {
    // Create multiple conversations to ensure scrollable sidebar
    for (let i = 0; i < 5; i++) {
      await createConversation(page, `Scroll test conversation ${i}`);
    }
    await ensureSidebarExpanded(page);

    // Get the sidebar scroll container
    const sidebar = page.locator('aside.transitions-enabled .overflow-y-auto').first();
    await expect(sidebar).toBeVisible();

    // Scroll down
    await sidebar.evaluate((el) => {
      el.scrollTop = 100;
      return el.scrollTop;
    });

    const scrollPositionBefore = await sidebar.evaluate((el) => el.scrollTop);
    expect(scrollPositionBefore).toBe(100);

    // Trigger refresh
    await triggerVisibilityChange(page);
    await page.waitForTimeout(2500);

    // Verify scroll position is preserved
    const scrollPositionAfter = await sidebar.evaluate((el) => el.scrollTop);
    expect(scrollPositionAfter).toBe(scrollPositionBefore);
  });
});
