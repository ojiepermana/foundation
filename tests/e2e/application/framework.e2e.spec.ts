import { expect, test } from '@playwright/test';
for (const width of [1280, 375]) {
  test(`APP-002 framework loads at ${width}px without server calls and proxy reaches real backend`, async ({page,request}) => {
    await page.setViewportSize({width,height:812});
    const apiCalls: string[] = []; const errors: string[] = [];
    page.on('request', r => {if(new URL(r.url()).pathname.startsWith('/api'))apiCalls.push(r.url());});
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('/');
    await expect(page.getByRole('heading',{name:'Foundation',exact:true})).toBeVisible();
    await expect(page.getByRole('main')).toContainText('Kerangka aplikasi siap dikembangkan.');
    expect(apiCalls).toEqual([]);
    expect(errors).toEqual([]);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link',{name:'Ke konten utama'})).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('main')).toBeFocused();
    const result = await request.get('/api/status');
    expect(result.status()).toBe(200);
    expect(await result.json()).toEqual({status:'ok'});
  });
}
