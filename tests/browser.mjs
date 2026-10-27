// Run on a machine with Playwright and Chromium installed. Uses actual UI input.
import {chromium} from 'playwright';
import {mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const url=process.env.TEST_URL||'http://127.0.0.1:8000';await mkdir('test-results',{recursive:true});
const browser=await chromium.launch({headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400)errors.push(r.status()+' '+r.url());});
try {
  await page.goto(url+'/?debug=1');await page.waitForFunction(()=>window.footballsim?.view.renderer.info.render.calls>0,{},{timeout:60000});
  assert.equal(await page.locator('#error').isVisible(),false);await page.screenshot({path:'test-results/01-welcome.png'});
  await page.getByRole('button',{name:'ENTER THE FIELD'}).click();await page.waitForFunction(()=>window.footballsim.sim.phase==='presnap');
  await page.screenshot({path:'test-results/02-presnap.png'});
  await page.getByRole('button',{name:'Choose play'}).click();assert.equal(await page.locator('.play-card').count(),8);await page.screenshot({path:'test-results/03-playbook.png'});
  await page.getByRole('button',{name:'Mesh concept — SHORT',exact:true}).click();
  await page.getByRole('button',{name:'SNAP BALL'}).click();await page.waitForFunction(()=>window.footballsim.sim.time>1.5);
  await page.keyboard.down('1');await page.waitForTimeout(250);await page.keyboard.up('1');
  await page.waitForFunction(()=>window.footballsim.sim.stats.attempts===1);await page.waitForFunction(()=>window.footballsim.sim.phase==='dead',{},{timeout:60000});
  assert.equal(await page.locator('#result').isVisible(),true);await page.screenshot({path:'test-results/04-pass-result.png'});
  await page.getByRole('button',{name:'Replay',exact:false}).first().click();assert.equal(await page.locator('#replay-controls').isVisible(),true);await page.waitForTimeout(800);await page.screenshot({path:'test-results/05-replay.png'});await page.locator('#replay-close').click();
  await page.getByRole('button',{name:'Call play',exact:true}).click();await page.getByRole('button',{name:'Inside zone — RUN',exact:true}).click();await page.getByRole('button',{name:'SNAP BALL'}).click();await page.waitForFunction(()=>window.footballsim.sim.handoff);await page.keyboard.down('w');await page.keyboard.down('Shift');await page.waitForFunction(()=>window.footballsim.sim.phase==='dead',{},{timeout:60000});await page.keyboard.up('w');await page.keyboard.up('Shift');
  assert.equal(await page.evaluate(()=>window.footballsim.sim.stats.attempts),1);await page.locator('#next').click();await page.keyboard.press('Escape');assert.equal(await page.locator('#pause').isVisible(),true);const t=await page.evaluate(()=>window.footballsim.sim.time);await page.waitForTimeout(150);assert.equal(await page.evaluate(()=>window.footballsim.sim.time),t);await page.locator('#resume').click();
  await page.locator('#settings-open').click();await page.locator('#graphics').selectOption('performance');assert.equal(await page.evaluate(()=>window.footballsim.view.renderer.shadowMap.enabled),false);await page.locator('#lighting').selectOption('sunset');await page.locator('#coverage').selectOption('blitz');await page.locator('#practice-mode').selectOption('drive');await page.locator('#apply-settings').click();assert.equal(await page.evaluate(()=>window.footballsim.sim.coverage),'blitz');
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'test-results/06-mobile.png'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.deepEqual(errors,[]);console.log('Browser checks passed: render, playbook, passing, handoff, replay, pause, settings, mobile layout.');
} finally {await browser.close();}
