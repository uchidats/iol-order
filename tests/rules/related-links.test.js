import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, collection, getDoc, getDocs, setDoc, deleteDoc, writeBatch, serverTimestamp } from 'firebase/firestore';
const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
let env;
test.before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-iol-r18', firestore: { host, port: Number(port), rules: fs.readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') } });
  await env.withSecurityRulesDisabled(async c => {
    const db = c.firestore();
    for (const fid of ['fA', 'fB', 'stopped']) {
      await setDoc(doc(db, 'facilities', fid), { status: fid === 'stopped' ? 'suspended' : 'active' });
      for (const role of ['admin', 'subadmin', 'orderer', 'proxy']) await setDoc(doc(db, 'facilities', fid, 'members', role + fid), { role });
      await setDoc(doc(db, 'facilities', fid, 'relatedLinks', 'custom-a'), { name: 'リンク', url: 'https://example.org', sortOrder: 10, enabled: true });
    }
  });
});
test.after(async () => { await env?.clearFirestore(); await env?.cleanup(); });
const as = uid => env.authenticatedContext(uid).firestore();
const data = (uid, over = {}) => ({ name: '施設リンク', url: 'https://example.org/path?q=1#x', sortOrder: 10, enabled: true, updatedAt: serverTimestamp(), updatedBy: uid, ...over });
test('R18 Rules: 有効な所属者だけが自施設のリンクを取得・一覧可能、別施設・未所属・未認証・停止施設は拒否', async () => {
  for (const role of ['admin', 'subadmin', 'orderer', 'proxy']) {
    const db = as(role + 'fA');
    await assertSucceeds(getDoc(doc(db, 'facilities/fA/relatedLinks/custom-a')));
    await assertSucceeds(getDocs(collection(db, 'facilities/fA/relatedLinks')));
    await assertFails(getDocs(collection(db, 'facilities/fB/relatedLinks')));
  }
  for (const db of [as('outsider'), as('adminstopped'), env.unauthenticatedContext().firestore(), env.authenticatedContext('ops', { platformAdmin: true }).firestore()]) {
    await assertFails(getDoc(doc(db, 'facilities/fA/relatedLinks/custom-a')));
    await assertFails(getDocs(collection(db, 'facilities/stopped/relatedLinks')));
  }
});
test('R18 Rules: 管理者・副管理者は作成・変更・並べ替え・独自リンク削除可能、他の役割は不可', async () => {
  for (const role of ['admin', 'subadmin']) {
    const uid = role + 'fA', db = as(uid), ref = doc(db, 'facilities/fA/relatedLinks/custom-' + role);
    await assertSucceeds(setDoc(ref, data(uid)));
    await assertSucceeds(setDoc(ref, data(uid, { name: '変更', enabled: false, sortOrder: 20 })));
    const b = writeBatch(db); b.set(ref, data(uid, { sortOrder: 0 })); b.set(doc(db, 'facilities/fA/relatedLinks/custom-a'), data(uid, { sortOrder: 10 }));
    await assertSucceeds(b.commit()); await assertSucceeds(deleteDoc(ref));
    await assertFails(setDoc(doc(db, 'facilities/fB/relatedLinks/custom-x'), data(uid)));
  }
  for (const role of ['orderer', 'proxy', 'outsider']) {
    const db = as(role + 'fA');
    await assertFails(setDoc(doc(db, 'facilities/fA/relatedLinks/custom-a'), data(role + 'fA')));
    await assertFails(deleteDoc(doc(db, 'facilities/fA/relatedLinks/custom-a')));
  }
});
test('R18 Rules: 標準文書は表示設定だけ、名前・URL・削除・未知の標準IDを拒否', async () => {
  const db = as('adminfA');
  for (const id of ['std-tecnis', 'std-alcon', 'std-teleon', 'std-santen', 'std-escrs']) {
    const ref = doc(db, 'facilities/fA/relatedLinks', id), d = { enabled: false, updatedBy: 'adminfA', updatedAt: serverTimestamp() };
    await assertSucceeds(setDoc(ref, d)); await assertSucceeds(setDoc(ref, { ...d, enabled: true }));
    await assertFails(setDoc(ref, { ...d, name: '偽装' })); await assertFails(setDoc(ref, { ...d, url: 'https://example.org' }));
    await assertFails(deleteDoc(ref));
  }
  await assertFails(setDoc(doc(db, 'facilities/fA/relatedLinks/std-unknown'), { enabled: true, updatedBy: 'adminfA', updatedAt: serverTimestamp() }));
});
test('R18 Rules: 許可フィールド・型・上限・変更者・HTTPS URL検証', async () => {
  const db = as('adminfA'), ref = doc(db, 'facilities/fA/relatedLinks/custom-validation');
  const valid = ['https://例え.テスト/資料', 'https://[::1]/', 'HTTPS://example.org/', 'https://example.org./', 'https://example.org', 'https://example.org:443/path?x=1#y', 'https://localhost/test', 'https://127.0.0.1:8080/a'];
  for (const url of valid) await assertSucceeds(setDoc(ref, data('adminfA', { url })));
  const invalid = ['http://example.org', 'javascript:alert(1)', 'https://u:p@example.org', 'https://@example.org', 'https://', 'https:///example.org', 'https://example..org', 'https://example.org\\x', 'https://example.org/\n', 'https://example.org/\u0000', 'https://example.org/\u007f', 'https://example.org/' + 'a'.repeat(2048)];
  for (const url of invalid) await assertFails(setDoc(ref, data('adminfA', { url })), url);
  for (const change of [{ name: '' }, { name: '　 \t' }, { name: 'x'.repeat(101) }, { enabled: 'yes' }, { sortOrder: -1 }, { sortOrder: 0.5 }, { updatedBy: 'subadminfA' }, { updatedAt: new Date(0) }, { unexpected: true }]) await assertFails(setDoc(ref, data('adminfA', change)));
  assert.ok(true);
});
