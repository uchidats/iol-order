import test from 'node:test';
import assert from 'node:assert/strict';
import { IOL_MODELS } from '../src/data/iol-models.js';
import { IOL_MODELS as SERVER_MODELS } from '../functions/src/iol-catalog.js';
import { filterPowersByModel } from '../src/domain/power-filter.js';
import { validateLens } from '../functions/src/orders.js';
import { resolveAdoptedModels } from '../src/data/static-repository.js';
import { planAdoptedWrites } from '../src/domain/facility-settings.js';
import { orderedMakers, orderedModelsOf } from '../src/domain/iol-order.js';

const cases = [
  { id: 'nidek-np-1', maker: 'NIDEK', model: 'NP-1', powers: [1,2,3,4,5,...Array.from({length:44},(_,i)=>5.5+i*0.5),28,29,30], invalid: ['0D','+1.5D','+4.5D','+27.5D','+29.5D','+30.5D'] },
  { id: 'kowa-pn6a', maker: 'KOWA', model: 'PN6A', powers: [6,7,8,9,...Array.from({length:33},(_,i)=>10+i*0.5)], invalid: ['+5.0D','+6.5D','+8.5D','+9.5D','+26.5D','+27.0D'] }
];

for (const spec of cases) {
  test(spec.model + ': 単焦点・非トーリックで一意に登録され、公式範囲の度数だけを選択・注文できる', () => {
    const matches = IOL_MODELS.filter(m=>m.id===spec.id);
    assert.equal(matches.length,1);
    const m=matches[0], server=SERVER_MODELS.find(m=>m.id===spec.id);
    assert.deepEqual([m.manufacturer,m.model,m.isToric,m.isMultifocal,m.toricModels], [spec.maker,spec.model,false,false,[]]);
    const expected=spec.powers.map(n=>'+'+n.toFixed(1)+'D');
    assert.deepEqual(filterPowersByModel(m),expected);
    for (const power of expected) assert.doesNotThrow(()=>validateLens(server,{power}));
    for (const power of spec.invalid) assert.throws(()=>validateLens(server,{power}),e=>e.code==='invalid-argument',power);
    assert.throws(()=>validateLens(server,{power:'+20.0D',toricModel:'OTHER'}),e=>e.code==='invalid-argument');
  });
}

test('追加IOL: 既存の採用設定とメーカー順を保持し、明示的な採用後だけ注文候補になる', () => {
  const existing=[{id:'jj-dib00v',catalogIolId:'jj-dib00v',facilityId:'f1',enabled:true,dealerId:'d1'}];
  const before=structuredClone(existing);
  assert.deepEqual(planAdoptedWrites(IOL_MODELS,existing,['jj-dib00v'],'f1'),[]);
  assert.deepEqual(resolveAdoptedModels(existing).map(m=>m.id),['jj-dib00v']);
  const ids=cases.map(c=>c.id);
  const writes=planAdoptedWrites(IOL_MODELS,existing,['jj-dib00v',...ids],'f1');
  assert.deepEqual(writes,cases.map(c=>({id:c.id,data:{facilityId:'f1',catalogIolId:c.id,enabled:true}})));
  assert.deepEqual(resolveAdoptedModels([...existing,...writes.map(w=>({id:w.id,...w.data}))]).map(m=>m.id),['jj-dib00v',...ids]);
  const setting={makerOrder:['J&J','ALCON','SANTEN','NIDEK','HOYA'],modelOrder:IOL_MODELS.filter(m=>!ids.includes(m.id)).map(m=>m.id)};
  assert.deepEqual(orderedMakers(IOL_MODELS,setting),[...setting.makerOrder,'KOWA']);
  assert.deepEqual(orderedModelsOf(IOL_MODELS,'NIDEK',setting).map(m=>m.id),['nidek-nsp-2','nidek-np-tx-toric','nidek-np-1']);
  assert.deepEqual(existing,before);
});
