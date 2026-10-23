import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const bootstrapUrl = '/#token=siteops-e2e-bootstrap';

async function reloadUntil(page: Page, check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    if (await check()) return;
    await page.waitForTimeout(600);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function openReviewWithPendingProposal(page: Page): Promise<void> {
  await reloadUntil(page, async () => {
    await page.getByRole('button', { name: '文章審閱' }).click();
    return (await page.locator('.proposal-row').filter({ hasText: '待審閱' }).count()) > 0;
  }, 'a pending proposal');
}

async function createTaskFromRadar(page: Page, cardIndex: number): Promise<void> {
  await page.getByRole('button', { name: '需求雷達' }).click();
  const card = page.locator('.opportunity-card').nth(cardIndex);
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: '建立審閱任務' }).click();
  await expect(page.getByText('審閱任務已建立。', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '今日營運' })).toBeVisible();
}

test('completes the guarded demo journey through review, apply, rollback, reject, skill and schedule controls', async ({ page }) => {
  const mutationRequests: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') mutationRequests.push(request.url());
  });

  await page.goto(bootstrapUrl, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: '今日營運' })).toBeVisible();
  await expect(page.getByText('DEMO · 僅供演示')).toBeVisible();
  await expect(page.getByText('連線與證據')).toBeVisible();
  if (await page.evaluate(() => window.location.hash) !== '') throw new Error('Bootstrap hash was not cleared after sign-in');

  const checkConnections = page.getByRole('button', { name: '檢查連線' });
  await checkConnections.focus();
  await expect(checkConnections).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByText('連線檢查已完成，狀態已更新。', { exact: true })).toBeVisible();

  // The first task exercises a real API task, SSE progress, and the review writer.
  let sseDisconnected = false;
  await page.route('**/api/tasks/*/events', async (route) => {
    sseDisconnected = true;
    await route.abort();
  });
  await createTaskFromRadar(page, 0);
  await page.waitForTimeout(350);
  await page.unroute('**/api/tasks/*/events');
  if (!sseDisconnected) throw new Error('The task SSE endpoint was not opened during the journey');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: '今日營運' })).toBeVisible();

  await openReviewWithPendingProposal(page);
  const firstPending = page.locator('.proposal-row').filter({ hasText: '待審閱' }).first();
  await firstPending.click();
  await expect(page.getByText('文字差異', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '隔離預覽', exact: true }).click();
  const preview = page.locator('iframe[title="提案內容預覽"]');
  await expect(preview).toBeVisible();
  expect(await preview.getAttribute('sandbox')).toBe('');
  await page.getByRole('button', { name: '文字差異', exact: true }).click();

  await page.getByRole('button', { name: '核准變更' }).click();
  await expect(page.getByRole('button', { name: '套用至 WordPress' })).toBeVisible();
  await page.getByRole('button', { name: '套用至 WordPress' }).click();
  await expect(page.locator('.review-detail').getByText('已套用', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '成效與 Skill' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '成效與 Skill' })).toBeVisible();
  await expect(page.getByText('實驗觀測', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '文章審閱' }).click();
  await expect(page.getByRole('button', { name: '核准回滾' })).toBeVisible();
  await page.getByRole('button', { name: '核准回滾' }).click();
  await expect(page.getByRole('button', { name: '執行回滾' })).toBeVisible();
  await page.getByRole('button', { name: '執行回滾' }).click();
  await expect(page.locator('.review-detail').getByText('已回滾', { exact: true })).toBeVisible();

  // A second proposal is rejected. No apply or rollback request may follow the reject.
  await createTaskFromRadar(page, 1);
  await openReviewWithPendingProposal(page);
  const secondPending = page.locator('.proposal-row').filter({ hasText: '待審閱' }).first();
  await secondPending.click();
  const requestsBeforeReject = mutationRequests.length;
  await page.getByRole('button', { name: '拒絕' }).click();
  await expect(page.locator('.review-detail').getByText('已拒絕', { exact: true })).toBeVisible();
  expect(mutationRequests.slice(requestsBeforeReject).some((url) => /\/apply$|\/rollback$/.test(url))).toBe(false);
  await expect(page.getByRole('button', { name: '套用至 WordPress' })).toHaveCount(0);

  // A completed task provides reflection evidence for the deterministic Skill flow.
  await page.getByRole('button', { name: '成效與 Skill' }).click();
  await expect(page.getByRole('button', { name: '提出 Skill 候選' })).toBeVisible();
  await page.getByRole('button', { name: '提出 Skill 候選' }).click();
  await expect(page.getByText('Skill 候選已建立。', { exact: true })).toBeVisible();
  const candidateSkill = page.locator('.skill-card').filter({ hasText: 'v2' });
  await expect(candidateSkill).toHaveCount(1);
  await candidateSkill.getByRole('button', { name: '執行評估' }).click();
  await expect(page.getByText('Skill 評估已完成，狀態已更新。', { exact: true })).toBeVisible();
  await expect(candidateSkill.getByText('已評估', { exact: true })).toBeVisible();
  await candidateSkill.getByRole('button', { name: '啟用 Skill' }).click();
  await expect(page.getByText('Skill 啟用請求已送出。', { exact: true })).toBeVisible();
  await expect(candidateSkill.getByText('使用中', { exact: true })).toBeVisible();

  // The built-in v1 baseline can be deliberately restored through the same guarded activation API.
  const baselineSkill = page.locator('.skill-card').filter({ hasText: 'v1' });
  await expect(baselineSkill.getByText('已退役', { exact: true })).toBeVisible();
  await baselineSkill.getByRole('button', { name: '恢復基線' }).click();
  await expect(page.getByText('Skill 啟用請求已送出。', { exact: true })).toBeVisible();
  await expect(baselineSkill.getByText('使用中', { exact: true })).toBeVisible();

  // Scheduling is a server-backed setting and does not wait for the 30-second tick.
  const scheduleToggle = page.getByRole('button', { name: '切換自動排程' });
  await expect(scheduleToggle).not.toHaveClass(/is-on/);
  await scheduleToggle.click();
  await expect(page.getByText('排程已開啟。', { exact: true })).toBeVisible();
  await expect(scheduleToggle).toHaveClass(/is-on/);
  await scheduleToggle.click();
  await expect(page.getByText('排程已關閉。', { exact: true })).toBeVisible();
  await expect(scheduleToggle).not.toHaveClass(/is-on/);

  // Every tab remains keyboard reachable on the mobile layout.
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileTabs: Array<{ name: string; heading: string }> = [
    { name: '今日營運', heading: '今日營運' },
    { name: '需求雷達', heading: '需求雷達' },
    { name: '文章審閱', heading: '文章審閱' },
    { name: '成效與 Skill', heading: '成效與 Skill' },
  ];
  for (const item of mobileTabs) {
    const tab = page.getByRole('button', { name: item.name });
    await tab.focus();
    await expect(tab).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: item.heading })).toBeVisible();
  }
  await expect(page.locator('.main-nav')).toBeVisible();
});
