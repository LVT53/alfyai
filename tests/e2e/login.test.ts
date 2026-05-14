import { test, expect } from '@playwright/test';

test.describe('Login Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await expect(page.getByLabel('Email address')).toBeVisible();
  });

  test('page loads with email and password fields', async ({ page }) => {
    await expect(page.locator('input[name="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.getByLabel('Remember me')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toContainText('Sign in');
  });

  test('remember me toggle is submitted with credentials', async ({ page }) => {
    let submittedBody: Record<string, unknown> | null = null;

    await page.route('**/api/auth/login', async (route) => {
      submittedBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: {
            id: 'user-1',
            email: 'admin@local',
            displayName: 'Admin User',
          },
        }),
      });
    });

    await page.fill('input[name="email"]', 'admin@local');
    await page.fill('input[type="password"]', 'admin123');
    await page.getByLabel('Remember me').check();
    await page.click('button[type="submit"]');

    await expect.poll(() => submittedBody).not.toBeNull();
    expect(submittedBody).toMatchObject({
      email: 'admin@local',
      password: 'admin123',
    });
    expect([true, 'true', 'on']).toContain(submittedBody?.rememberMe);
  });

  test('submitting valid credentials redirects to main app', async ({ page }) => {
    // Fill in valid credentials
    await page.fill('input[name="email"]', 'admin@local');
    await page.fill('input[type="password"]', 'admin123');
    
    // Submit the form
    await page.click('button[type="submit"]');
    
    // Wait for navigation and check URL
    await expect(page).toHaveURL('/', { timeout: 15000 });
  });

  test('submitting invalid credentials shows error message', async ({ page }) => {
    // Fill in invalid credentials
    await page.fill('input[name="email"]', 'admin@local');
    await page.fill('input[type="password"]', 'wrongpassword');
    
    // Submit the form
    await page.click('button[type="submit"]');
    
    // Check for error message
    await expect(page.locator('[role="alert"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[role="alert"]')).toContainText('Invalid email or password');
  });

  test('error message disappears when user starts typing again', async ({ page }) => {
    // Fill in invalid credentials and submit
    await page.fill('input[name="email"]', 'admin@local');
    await page.fill('input[type="password"]', 'wrongpassword');
    await page.click('button[type="submit"]');
    
    // Verify error is shown
    await expect(page.locator('[role="alert"]')).toBeVisible({ timeout: 10000 });
    
    // Start typing in email field - error should disappear
    await page.fill('input[name="email"]', 'a');
    // Wait for error to disappear
    await expect(page.locator('[role="alert"]')).not.toBeVisible({ timeout: 10000 });
  });
});
