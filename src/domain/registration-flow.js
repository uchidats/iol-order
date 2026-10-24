/**
 * 施設登録フローのクライアント側補助
 *
 * リクエストID: 登録の「1回の意思表示」を識別する。通信エラー等の後に再試行しても同じIDを送るため、
 * サーバー側で二重作成にならない(冪等)。施設名を変えたら別の登録として新しいIDにする。
 * これは施設IDではない（施設IDはサーバーがこのIDから導出して生成する）。
 */
export const REGISTER_REQUEST_KEY = "iol_order_register_request"; // sessionStorage

const safe = (fn, fallback = null) => { try { return fn(); } catch (e) { return fallback; } };

export function normalizeFacilityName(s) {
  return String(s ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function validateFacilityName(s) {
  const n = normalizeFacilityName(s);
  if (!n) return "施設名を入力してください";
  if (n.length > 100) return "施設名は100文字以内で入力してください";
  return "";
}

export function getRequestId(storage, name, uuid = () => crypto.randomUUID()) {
  const n = normalizeFacilityName(name);
  const saved = safe(() => JSON.parse(storage.getItem(REGISTER_REQUEST_KEY)));
  if (saved && saved.name === n && typeof saved.requestId === "string") return saved.requestId;
  const requestId = uuid();
  safe(() => storage.setItem(REGISTER_REQUEST_KEY, JSON.stringify({ name: n, requestId })));
  return requestId;
}

export function clearRequestId(storage) {
  safe(() => storage.removeItem(REGISTER_REQUEST_KEY));
}
