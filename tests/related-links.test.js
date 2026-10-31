import test from 'node:test';
import assert from 'node:assert/strict';
import { STANDARD_LINKS, visibleRelatedLinks, validateRelatedLink, planRelatedLinkWrites } from '../src/domain/related-links.js';
import { createFirestoreRepository, createFirestoreSettingsApi } from '../src/data/firestore-repository.js';

const custom = (over = {}) => ({ id: 'custom-a', name: '施設リンク', url: 'https://example.org/path?q=1#x', enabled: true, sortOrder: 10, ...over });
test('R18: 標準5件の名称・URL・順序を保持し固定IDで表示を管理、新規標準は初期表示', () => {
  assert.deepEqual(STANDARD_LINKS.map(r => [r.id, r.name, r.url]), [
    ['std-tecnis', 'TECNIS Eyhance Toric Calculator', 'https://tecnistoriccalc.com'],
    ['std-alcon', 'Alcon Online Toric IOL Calculator', 'https://www.myalcon-toriccalc.com'],
    ['std-teleon', 'LENTIS Toric Lens Configulator', 'https://www.teleon-toric.com'],
    ['std-santen', 'レンティス コンフォート トーリック カリキュレーター', 'https://www.santen-iol.jp/SantenSite/'],
    ['std-escrs', 'ESCRS IOL calculator', 'https://iolcalculator.escrs.org']
  ]);
  const standards = [...STANDARD_LINKS.map(r => ({ ...r, name: '改名', url: 'https://new.example' })), { id: 'std-new', name: '新規', url: 'https://new.example' }];
  assert.equal(visibleRelatedLinks([{ id: 'std-alcon', enabled: false }], standards).length, 5);
  assert.equal(visibleRelatedLinks([], standards).at(-1).id, 'std-new');
});
test('R18: 独自リンクの並び順、非表示、不正な保存値、表示0件', () => {
  const hidden = STANDARD_LINKS.map(r => ({ id: r.id, enabled: false }));
  assert.deepEqual(visibleRelatedLinks(hidden), []);
  assert.deepEqual(visibleRelatedLinks([...hidden, custom(), custom({ id: 'custom-b', sortOrder: 0 }), custom({ id: 'custom-c', enabled: false }), custom({ id: 'custom-bad', url: 'javascript:alert(1)' })]).map(r => r.id), ['custom-b', 'custom-a']);
});
test('R18: HTTPS・認証情報・制御文字・名前・長さ・ホストの検証', () => {
  for (const url of ['https://例え.テスト/資料', 'https://[::1]/', 'HTTPS://example.org/', 'https://example.org./']) assert.ok(validateRelatedLink(custom({ url })).ok, url);
  assert.ok(validateRelatedLink(custom()).ok);
  assert.ok(validateRelatedLink(custom({ name: 'a'.repeat(100) })).ok);
  for (const url of ['http://example.org', 'https://u:p@example.org', 'https://@example.org', 'https:///example.org', 'https://', 'https://example.org\\foo', 'https://example..org', 'https://-example.org', 'https://example.org:99999', 'https://example.org/\n', 'https://example.org/\u007f', 'https://example.org/' + 'x'.repeat(2048), 'javascript:alert(1)']) assert.equal(validateRelatedLink(custom({ url })).ok, false, url);
  for (const name of ['', ' \n\t', 'x'.repeat(101)]) assert.equal(validateRelatedLink(custom({ name })).ok, false);
});
test('R18: 変更文書だけを保存し不正な草稿は有効な別行の保存を妨げない', () => {
  const docs = [custom()];
  assert.deepEqual(planRelatedLinkWrites(docs, docs), { upserts: [], deletes: [] });
  const p = planRelatedLinkWrites(docs, [custom({ name: '変更' }), custom({ id: 'draft', name: '' }), { id: 'std-alcon', enabled: false }, { id: 'std-escrs', enabled: true }]);
  assert.deepEqual(p.upserts.map(r => r.id), ['custom-a', 'std-alcon']);
  assert.deepEqual(p.upserts[1].data, { enabled: false });
});
test('R18: Repository/APIは施設ごとのコレクションを使い並べ替え・削除を同じバッチで保存する', async () => {
  const ops = []; let commits = 0;
  const sdk = { collection: (...x) => x.slice(1).join('/'), doc: (...x) => x.slice(1).join('/'), getDocs: async p => { ops.push(['read', p]); return { docs: [{ id: 'custom-a', data: () => custom() }] }; }, serverTimestamp: () => 'now', writeBatch: () => ({ set: (...a) => ops.push(['set', ...a]), delete: (...a) => ops.push(['delete', ...a]), commit: async () => { commits++; } }) };
  const repository = createFirestoreRepository({}, sdk), api = createFirestoreSettingsApi({}, sdk, { getUid: () => 'u1' });
  await repository.listRelatedLinks('f1');
  await api.saveRelatedLinks('f1', { upserts: [{ id: 'custom-b', data: custom() }], deletes: ['custom-a'] });
  assert.equal(commits, 1); assert.deepEqual(ops[0], ['read', 'facilities/f1/relatedLinks']);
  assert.equal(ops[1][1], 'facilities/f1/relatedLinks/custom-b'); assert.equal(ops[1][2].updatedBy, 'u1'); assert.equal(ops[1][2].updatedAt, 'now');
  assert.deepEqual(ops[2], ['delete', 'facilities/f1/relatedLinks/custom-a']);
});
