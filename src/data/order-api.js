/**
 * 注文受付(Cloud Functions の callable createOrder)の呼び出し口。
 * クライアントが送るのは「何を選んだか」の識別子だけで、注文番号・状態・注文者名・レンズ名などは
 * すべてサーバーが決める。同じ requestId の再送は二重登録にならない(サーバー側で冪等)。
 *
 * @param {object} deps
 * @param {object} deps.functions firebase-functions の Functions インスタンス
 * @param {Function} deps.httpsCallable
 */
export function createOrderApi({ functions, httpsCallable }) {
  return {
    /** @returns {Promise<{orderId:string, orderNumber:string, status:string, replayed:boolean}>} */
    createOrder: async (request) => (await httpsCallable(functions, "createOrder")(request)).data
  };
}
