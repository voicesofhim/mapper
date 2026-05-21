import { test, expect } from './fixtures.js';

test.describe('Accelerator Observatory', () => {
  test('Ask response highlights nodes and filters evidence', async ({ page }) => {
    await page.goto('/mapper/');
    await page.getByRole('button', { name: 'Open observatory' }).click();
    await page.getByRole('button', { name: 'Which participants need structure before they can execute?' }).click();

    await expect(page.getByText('Inference: P-02 most clearly needs structure before execution')).toBeVisible();
    await expect(page.locator('.video-panel-count')).toHaveText('5');
    await expect(page.locator('.video-panel-item-title').filter({ hasText: 'Needs structure before execution' })).toBeVisible();

    const highlightedPixels = await page.locator('#map-container canvas').evaluate((canvas) => {
      const ctx = canvas.getContext('2d');
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let bright = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] + data[i + 1] + data[i + 2] > 520) bright++;
      }
      return bright;
    });
    expect(highlightedPixels).toBeGreaterThan(10);
  });

  test('map lenses filter by participant and source type', async ({ page }) => {
    await page.goto('/mapper/');
    await page.getByRole('button', { name: 'Open observatory' }).click();

    await page.getByLabel('Filter by participant').selectOption('P-02');
    await expect(page.locator('.video-panel-count')).toHaveText('3');

    await page.getByLabel('Filter by source type').selectOption('interview');
    await expect(page.locator('.video-panel-count')).toHaveText('1');
    await expect(page.getByText('Needs structure before execution')).toBeVisible();
  });
});
