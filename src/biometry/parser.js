/** OA-2000等の測定結果テキストのパース（推測・補完は行わない） */

/**
 * OA-2000等の測定結果テキストパース正規表現
 * - 患者名（ローマ字）抽出を含む
 * - 大文字小文字・スペース・姓名順を勝手に補正しない
 */
export function parseBiometryText(text, baseConfidencePct) {
  const result = {
    patientName: null,
    al: null,
    acd: null,
    k1: null,
    k1Axis: null,
    k2: null,
    k2Axis: null,
    wtw: null
  };

  if (!text) return result;

  const cleanText = text.replace(/,/g, ".").replace(/[\r\n]+/g, "\n");
  const baseConf = Math.min(0.95, Math.max(0.40, baseConfidencePct / 100));

  // 0. 患者名 (ローマ字) パース
  // 例: "Name: YAMADA TARO", "NAME TANAKA HANAKO", "Patient: SUZUKI ICHIRO"
  // 大文字小文字・スペース・姓名順をそのまま保持
  const nameMatch = cleanText.match(/(?:NAME|Name|PATIENT|Patient)[^\w\n]{0,8}([A-Za-z]+(?:\s+[A-Za-z]+)+)/);
  if (nameMatch) {
    const rawName = nameMatch[1].trim();
    if (rawName.length >= 3 && !/\d/.test(rawName)) {
      result.patientName = {
        value: rawName,
        confidence: baseConf
      };
    }
  }

  // 1. 眼軸長 AL
  const alMatch = cleanText.match(/(?:AL|AXIAL|Axial(?:\s*Length)?)[^\d]{0,8}(\d{2}\.\d{1,3})/i);
  if (alMatch) {
    const val = parseFloat(alMatch[1]);
    if (!isNaN(val) && val >= 16.0 && val <= 38.0) {
      result.al = {
        value: Math.round(val * 100) / 100,
        confidence: baseConf
      };
    }
  }

  // 2. 前房深度 ACD
  const acdMatch = cleanText.match(/(?:ACD|A\.C\.D)[^\d]{0,8}(\d\.\d{1,3})/i);
  if (acdMatch) {
    const val = parseFloat(acdMatch[1]);
    if (!isNaN(val) && val >= 1.5 && val <= 5.5) {
      result.acd = {
        value: Math.round(val * 100) / 100,
        confidence: baseConf
      };
    }
  }

  // 3. K1 & K1 Axis
  const k1Match = cleanText.match(/(?:K1|R1)[^\d]{0,8}(\d{2}\.\d{1,3})(?:[^\d\n]{1,15}(\d{1,3})(?:°|deg|度)?)?/i);
  if (k1Match) {
    const valK1 = parseFloat(k1Match[1]);
    if (!isNaN(valK1) && valK1 >= 32.0 && valK1 <= 58.0) {
      result.k1 = {
        value: Math.round(valK1 * 100) / 100,
        confidence: baseConf
      };

      if (k1Match[2]) {
        const valAxis = parseInt(k1Match[2], 10);
        if (!isNaN(valAxis) && valAxis >= 0 && valAxis <= 180) {
          result.k1Axis = {
            value: valAxis,
            confidence: baseConf * 0.9
          };
        }
      }
    }
  }

  // 4. K2 & K2 Axis
  const k2Match = cleanText.match(/(?:K2|R2)[^\d]{0,8}(\d{2}\.\d{1,3})(?:[^\d\n]{1,15}(\d{1,3})(?:°|deg|度)?)?/i);
  if (k2Match) {
    const valK2 = parseFloat(k2Match[1]);
    if (!isNaN(valK2) && valK2 >= 32.0 && valK2 <= 58.0) {
      result.k2 = {
        value: Math.round(valK2 * 100) / 100,
        confidence: baseConf
      };

      if (k2Match[2]) {
        const valAxis = parseInt(k2Match[2], 10);
        if (!isNaN(valAxis) && valAxis >= 0 && valAxis <= 180) {
          result.k2Axis = {
            value: valAxis,
            confidence: baseConf * 0.9
          };
        }
      }
    }
  }

  // 5. 角膜径 WTW
  const wtwMatch = cleanText.match(/(?:WTW|W-W|White)[^\d]{0,8}(\d{1,2}\.\d{1,2})/i);
  if (wtwMatch) {
    const valWtw = parseFloat(wtwMatch[1]);
    if (!isNaN(valWtw) && valWtw >= 8.5 && valWtw <= 14.5) {
      result.wtw = {
        value: Math.round(valWtw * 10) / 10,
        confidence: baseConf * 0.85
      };
    }
  }

  return result;
}
