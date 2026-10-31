import { newFakeContext } from "./fake-firebase.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright-core';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = `<script type="module">
import { createFacilitySettings } from '/src/ui/facility-settings.js';
import { createRelatedLinksView } from '/src/ui/related-links.js';
import { initOrderForm } from '/src/ui/order-form.js';
import { IOL_MODELS } from '/src/data/iol-models.js';
const read = () => JSON.parse(localStorage.getItem('__links') || '[]');
window.__fail=0; window.__delay=0; window.__active=0; window.__max=0; window.__calls=[]; window.__readFail=false;
const repository = {
 listOrderers: async()=>[{id:'o1',name:'医師'}], listDealers:async()=>[], listAdoptedIols:async()=>IOL_MODELS.map(m=>({id:m.id,catalogIolId:m.id,enabled:true})),
 listRelatedLinks:async()=>{ if(window.__readFail)throw Error('read'); return read(); }
};
const view = createRelatedLinksView(); window.__view=view;
await initOrderForm({config:{orderMode:'server-dev'},repository,facilityId:'f1',facility:{id:'f1',name:'テスト施設'},user:{uid:'u1'}});
await view.load('f1',repository);
const settingsApi={saveOrderers:async()=>{},saveAdoptedIols:async()=>{},saveDealers:async()=>{},saveMailSettings:async()=>{},
 async saveRelatedLinks(fid,plan){
  window.__active++;window.__max=Math.max(window.__max,window.__active);
  try{await new Promise(r=>setTimeout(r,window.__delay));if(window.__fail>0){window.__fail--;throw Error('network');}
   const db=new Map(read().map(r=>[r.id,r]));for(const w of plan.upserts)db.set(w.id,{id:w.id,...w.data});for(const id of plan.deletes)db.delete(id);
   localStorage.setItem('__links',JSON.stringify([...db.values()]));window.__calls.push(plan);
  }finally{window.__active--;}
 }
};
const s=createFacilitySettings({mount:document.querySelector('main'),repository,settingsApi,masters:IOL_MODELS,onSaved:async()=>{},onRelatedLinksSaved:(fid,docs)=>view.saved(fid,docs),onClose(){}});
window.__settings=s;await s.open({id:'f1',name:'テスト施設'});window.__ready=true;
</script>`;
const PAGE = fs.readFileSync(path.join(ROOT,'index.html'),'utf8')
 .replace(/<script src="https:\/\/cdn[^\"]*"><\/script>/,'')
 .replace(/<script type="module" src="src\/main\.js[^\"]*"><\/script>/,SCRIPT);
let server, base;
test.before(async()=>{
 server=http.createServer((req,res)=>{
  const pathname=decodeURIComponent(req.url.split('?')[0]);
  if(pathname==='/app'){res.setHeader('content-type','text/html; charset=utf-8');res.end(fs.readFileSync(path.join(ROOT,'index.html'),'utf8'));return;}
  if(pathname==='/'){res.setHeader('content-type','text/html; charset=utf-8');res.end(PAGE);return;}
  const p=path.resolve(ROOT,'.'+pathname);if(!p.startsWith(ROOT+path.sep)){res.writeHead(403);res.end();return;}
  fs.readFile(p,(err,data)=>{if(err){res.writeHead(404);res.end();return;}res.setHeader('content-type',({'.js':'text/javascript','.css':'text/css','.json':'application/json'}[path.extname(p)]||'text/plain')+'; charset=utf-8');res.end(data);});
 }).listen(0);await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port+'/';
});
test.after(()=>server?.close());
for(const [name,type] of [['chromium',chromium],['firefox',firefox],['webkit',webkit]]){
 test('R18 browser: 自動保存・草稿・連続編集・削除・再試行・順序・表示・離脱・施設分離 '+name,async()=>{
  const browser=await type.launch(name === "chromium" ? {channel:"msedge"} : {});
  try{
   const context=await browser.newContext({viewport:{width:390,height:1000}});await context.route(/^https?:\/\/(?!127\.0\.0\.1)/,r=>r.abort());
   const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));await page.goto(base);await page.waitForFunction(()=>window.__ready);
   const section=page.locator('[data-section="relatedLinks"]'), rows=section.locator('[data-custom-links] > div');
   const waitSaved=async n=>page.waitForFunction(n=>JSON.parse(localStorage.getItem('__links')||'[]').filter(r=>!r.id.startsWith('std-')).length===n,n);
   const add=async(name,url)=>{await section.locator('[data-act="add"]').click();const row=rows.last();await row.getByLabel('リンク名',{exact:true}).fill(name);await row.getByLabel('リンクURL',{exact:true}).fill(url);return row;};
   assert.equal(await page.locator('.ref-links-list a').count(),5);assert.equal(await page.locator('.ref-links-accordion').getAttribute('open'),null);
   const first=await add('施設資料','https://example.org/a');await waitSaved(1);
   // 入力停止500msまでは保存しない。編集中の行は保存後も入力欄・フォーカスを維持。
   await first.getByLabel('リンク名',{exact:true}).fill('変更資料');assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('__links'))[0].name),'施設資料');
   await page.waitForFunction(()=>JSON.parse(localStorage.getItem('__links'))[0].name==='変更資料');assert.equal(await first.getByLabel('リンク名',{exact:true}).inputValue(),'変更資料');
   const second=await add('二番目','https://example.org/b');await waitSaved(2);
   await second.locator('[data-act="up"]').click();await page.waitForFunction(()=>JSON.parse(localStorage.getItem('__links')).find(r=>r.name==='二番目').sortOrder===10);
   assert.equal(await rows.first().locator('.related-link-name').textContent(),'二番目');
   // 不正な草稿と独立して標準リンクの切替を保存。
   await add('<img src=x onerror=alert(1)>','javascript:alert(1)');await section.locator('[data-id="std-alcon"] input').uncheck();
   await page.waitForFunction(()=>JSON.parse(localStorage.getItem('__links')).some(r=>r.id==='std-alcon'&&!r.enabled));assert.equal(await rows.count(),3);
   assert.equal(await page.locator('.related-link-name img').count(),0);
   await page.evaluate(()=>{window.__fail=1;});await section.locator('[data-id="std-tecnis"] input').uncheck();
   await section.locator('[data-act="retry-autosave"]').waitFor();await section.locator('[data-act="retry-autosave"]').click();
   await page.waitForFunction(()=>JSON.parse(localStorage.getItem('__links')).some(r=>r.id==='std-tecnis'&&!r.enabled));
   // 同じ施設の読込失敗を「未設定」として上書きしない。注文入力は継続。
   await page.locator('#notesInput').fill('入力内容を保持');
   for(const width of [320,360,390,430,1100]){
    await page.setViewportSize({width,height:1000});
    assert.ok(await section.evaluate(e=>e.getBoundingClientRect().right<=innerWidth),'設定欄の横幅 '+width);
    assert.ok(await page.locator('.related-link-editor input').first().evaluate(e=>e.getBoundingClientRect().right<=innerWidth),'入力欄 '+width);
   }
   await page.setViewportSize({width:390,height:1000}); await page.screenshot({path:'.env.r18-settings-'+name+'.png',fullPage:true});
   let prompt='';page.once('dialog',async d=>{prompt=d.message();await d.dismiss();});await page.locator('#btnSettingsClose').click();
   assert.match(prompt,/この画面を離れると、未保存の入力や保存に失敗した変更が破棄されます/);assert.equal(await page.locator('#facilitySettings').getAttribute('hidden'),null);
   page.once('dialog',d=>d.accept());await rows.last().locator('[data-act="delete"]').click();await page.waitForFunction(()=>document.querySelectorAll('[data-custom-links]>div').length===2);
   // 保存処理中に編集・削除。古い値の復活・同時保存なし。
   await page.evaluate(()=>{window.__delay=800;});const current=rows.first();await current.getByLabel('リンク名',{exact:true}).fill('保存中1');
   await page.waitForFunction(()=>window.__active===1);await current.getByLabel('リンク名',{exact:true}).fill('保存中2');
   page.once('dialog',d=>d.accept());await current.locator('[data-act="delete"]').click();await waitSaved(1);
   await page.waitForFunction(()=>window.__active===0);assert.equal(await page.evaluate(()=>window.__max),1);
   assert.equal(await page.locator('#notesInput').inputValue(),'入力内容を保持');
   await page.locator('#btnSettingsClose').click();await page.locator('.ref-links-summary').click();assert.equal(await page.locator('.ref-links-list a').count(),4);
   assert.ok((await page.locator('.ref-links-list a').last().getAttribute('rel')).includes('noreferrer'));
   // 別施設の遅延読込、保存成功後の古い読込、取得失敗。
   await page.evaluate(async()=>{
    let resolve;const delayed=window.__view.load('old',{listRelatedLinks:()=>new Promise(r=>resolve=r)});
    await window.__view.load('new',{listRelatedLinks:async()=>[{id:'custom-new',name:'新施設',url:'https://new.example',enabled:true,sortOrder:1}]});resolve([{id:'custom-old',name:'旧施設',url:'https://old.example',enabled:true,sortOrder:1}]);await delayed;
   });assert.equal(await page.locator('.ref-links-list a').last().textContent(),'新施設');
   await page.evaluate(()=>window.__view.saved('old',[]));assert.equal(await page.locator('.ref-links-list a').last().textContent(),'新施設');
   await page.evaluate(()=>window.__view.load('failure',{listRelatedLinks:async()=>{throw Error('read');}}));assert.equal(await page.locator('.ref-links-accordion').isVisible(),false);
   await page.reload();await page.waitForFunction(()=>window.__ready);assert.equal(await rows.count(),1);assert.equal(await page.locator('.ref-links-list a').count(),4);
   // 全項目OFFは表示を隠す。
   for(const check of await section.locator('.related-setting-row input[type="checkbox"]').all())if(await check.isChecked())await check.uncheck();
   await page.waitForFunction(()=>document.querySelector('.ref-links-accordion').hidden);
   // 保存前の遅延読込は、保存成功後の表示を上書きしない。
   await page.evaluate(async()=>{let done;const loading=window.__view.load('f1',{listRelatedLinks:()=>new Promise(r=>done=r)});window.__view.saved('f1',[{id:'custom-saved',name:'保存後',url:'https://saved.example',enabled:true,sortOrder:1}]);done([]);await loading;});
   assert.equal(await page.locator('.ref-links-list a').last().textContent(),'保存後');
   // 失敗を破棄して開き直すと、未保存状態と再試行ボタンを持ち越さない。
   await page.evaluate(()=>{window.__fail=1;});await section.locator('[data-id="std-escrs"] input').check();
   await section.locator('[data-act="retry-autosave"]').waitFor();page.once('dialog',d=>d.accept());await page.locator('#btnSettingsClose').click();
   await page.evaluate(()=>window.__settings.open({id:'f1',name:'テスト施設'}));assert.equal(await section.locator('[data-act="retry-autosave"]').count(),0);
   await page.evaluate(async()=>{window.__readFail=true;await window.__settings.open({id:'f1',name:'テスト施設'});});
   await section.locator('[data-act="retry-load"]').waitFor();assert.equal(await section.locator('[data-act="add"]').isDisabled(),true);
   await page.evaluate(()=>{window.__readFail=false;});await section.locator('[data-act="retry-load"]').click();
   await page.waitForFunction(()=>!document.querySelector('[data-section="relatedLinks"] [data-act="add"]').disabled);
   assert.deepEqual(errors,[]);await context.close();
  }finally{await browser.close();}
 });
}

test('R18 main.js: メニュー・ハッシュの離脱キャンセルと同施設の読み込み', async()=>{
 const browser=await chromium.launch({channel:'msedge'});
 try {
  const context=await newFakeContext(browser,base,390,{
   user:{uid:'u1',email:'u1@example.jp',emailVerified:true},
   db:{'facilities/f1':{name:'施設A',status:'active'},'facilities/f1/members/u1':{uid:'u1',role:'admin'},
    'facilities/f1/relatedLinks/custom-a':{name:'施設Aの資料',url:'https://example.org/a',enabled:true,sortOrder:10}}
  });
  const page=await context.newPage();await page.goto(base+'app');await page.locator('.ref-links-list a').last().waitFor({state:'attached'});
  assert.equal(await page.locator('.ref-links-list a').last().textContent(),'施設Aの資料');
  const menu=async item=>{await page.click('#btnHeaderMenu');await page.click(item);};
  await menu('#menuFacilitySettings');await page.locator('[data-section="relatedLinks"] [data-act="add"]').click();
  for(const item of ['#menuOrderHistory','#menuHelp','#menuFacilitySettings']){
   const dialog=page.waitForEvent('dialog');const click=menu(item);const d=await dialog;assert.match(d.message(),/未保存の入力や保存に失敗した変更/);await d.dismiss();await click;
   assert.equal(await page.locator('#facilitySettings').getAttribute('hidden'),null);
   assert.equal(await page.locator('[data-custom-links]>div').count(),2);
  }
  const dialog=page.waitForEvent('dialog');await page.evaluate(()=>{location.hash='#help';});const d=await dialog;await d.dismiss();
  await page.waitForFunction(()=>location.hash==='');assert.equal(await page.locator('#facilitySettings').getAttribute('hidden'),null);
  const last=page.waitForEvent('dialog');const click=menu('#menuHelp');const leave=await last;await leave.accept();await click;
  await page.locator('#manualView:not([hidden])').waitFor();assert.equal(await page.locator('#facilitySettings').isVisible(),false);
  await context.close();
 } finally {await browser.close();}
});
