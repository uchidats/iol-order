/** 生体計測の内部状態（rawAiValues と userConfirmedValues を分離して保持） */

/**
 * 生体計測データの内部状態管理
 * - rawAiValues: AI/OCRで抽出された未加工値（値と信頼度をペアで保持）
 * - userConfirmedValues: ユーザーが目視確認・修正した確定値（安全性担保）
 */
export const biometryState = {
  // 1. AI/OCR抽出値 (各項目ごとに値と信頼度を分離保持)
  rawAiValues: {
    patientName: { value: null, confidence: null },
    al: { value: null, confidence: null },
    acd: { value: null, confidence: null },
    k1: { value: null, confidence: null },
    k1Axis: { value: null, confidence: null },
    k2: { value: null, confidence: null },
    k2Axis: { value: null, confidence: null },
    wtw: { value: null, confidence: null },
    rawText: "",
    engine: "Tesseract.js (Client-Side)",
    analyzedAt: null
  },

  // 2. ユーザーが目視確認・修正した確定値
  userConfirmedValues: {
    patientName: null,
    al: null,
    acd: null,
    k1: null,
    k1Axis: null,
    k2: null,
    k2Axis: null,
    wtw: null,
    isConfirmed: false,
    confirmedAt: null
  },

  // 選択画像のキャッシュ
  selectedImageDataUrl: null,
  selectedFileName: null
};

// 入力フィールドと対応するバッジ要素のマッピング
export const BIOMETRY_FIELDS = [
  { id: "ocrPatientName", key: "patientName", badgeId: "statusBadge-patientName", label: "患者名", isText: true },
  { id: "ocrAL", key: "al", badgeId: "statusBadge-al", label: "眼軸長 AL", unit: "mm" },
  { id: "ocrACD", key: "acd", badgeId: "statusBadge-acd", label: "前房深度 ACD", unit: "mm" },
  { id: "ocrK1", key: "k1", badgeId: "statusBadge-k1", label: "K1", unit: "D" },
  { id: "ocrK1Axis", key: "k1Axis", badgeId: "statusBadge-k1Axis", label: "K1 Axis", unit: "°" },
  { id: "ocrK2", key: "k2", badgeId: "statusBadge-k2", label: "K2", unit: "D" },
  { id: "ocrK2Axis", key: "k2Axis", badgeId: "statusBadge-k2Axis", label: "K2 Axis", unit: "°" },
  { id: "ocrWTW", key: "wtw", badgeId: "statusBadge-wtw", label: "角膜径 WTW", unit: "mm" }
];

// ==========================================================================
// 10-A. リアルタイム連続読み取り状態管理 (コンセンサス安定化方式)
// ==========================================================================
export const liveOcrState = {
  stream: null,
  intervalId: null,
  isProcessing: false,
  sampleIntervalMs: 800, // 約800msごとに1フレーム解析
  requiredMatches: 3,    // 3フレーム連続または累積一致で「読み取り済み」判定
  // 候補追跡バッファ
  history: {
    patientName: { candidate: null, count: 0 },
    al: { candidate: null, count: 0 },
    acd: { candidate: null, count: 0 },
    k1: { candidate: null, count: 0 },
    k1Axis: { candidate: null, count: 0 },
    k2: { candidate: null, count: 0 },
    k2Axis: { candidate: null, count: 0 },
    wtw: { candidate: null, count: 0 }
  },
  // 確定フラグ
  confirmed: {
    patientName: false,
    al: false,
    acd: false,
    k1: false,
    k1Axis: false,
    k2: false,
    k2Axis: false,
    wtw: false
  }
};
