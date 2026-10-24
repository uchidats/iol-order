// 【自動複製】src/data/iol-models.js の複製。直接編集しない。
// 元ファイルを変更したら `npm run sync:catalog` で更新する(tests/functions-catalog-sync.test.js が不一致を検出する)。
/**
 * IOLモデル・度数マスター（Google Form準拠）
 * id は施設の採用IOL（adoptedIols のドキュメントID / catalogIolId）が参照する不変の識別子。変更・再利用しないこと。
 * 将来は Firestore の iolCatalog コレクションへ移行する（docs/firestore-data-model.md 参照）。
 */

/**
 * Google Formに登録されているメーカー・モデルマスター
 * 要件指定のデータ構造:
 * {
 *   manufacturer: "...",
 *   model: "...",
 *   isToric: true / false,
 *   toricModels: [...],
 *   powerRange: { min: ..., max: ..., step: ..., customSteps: [...] },
 *   calculatorUrl: "...",
 *   notes: "..."
 * }
 */
export const IOL_MODELS = [
  // 1. J&J / DIB00V
  {
    manufacturer: "J&J",
    model: "DIB00V",
    id: "jj-dib00v",
    displayName: "J&J / DIB00V",
    isToric: false,
    toricModels: [],
    powerRange: { min: 6.0, max: 30.0, step: 0.5, default: 20.0 },
    calculatorUrl: "",
    notes: "+6.0～+30.0D [0.5ステップ]"
  },
  // 2. J&J / DIWxxx (トーリック)
  {
    manufacturer: "J&J",
    model: "DIWxxx (トーリック)",
    id: "jj-diwxxx-toric",
    displayName: "J&J / DIWxxx (トーリック)",
    isToric: true,
    toricModels: [
      "DIW150",
      "DIW225",
      "DIW300",
      "DIW375",
      "DIW450",
      "DIW525",
      "DIW600"
    ],
    powerRange: { min: 6.0, max: 30.0, step: 0.5, default: 20.0 },
    calculatorUrl: "https://tecnistoriccalc.com",
    notes: "+6.0～+30.0D [0.5ステップ]"
  },
  // 3. ALCON / CNA0T0
  {
    manufacturer: "ALCON",
    model: "CNA0T0",
    id: "alcon-cna0t0",
    displayName: "ALCON / CNA0T0",
    isToric: false,
    toricModels: [],
    powerRange: { min: 6.0, max: 30.0, step: 0.5, default: 20.0 },
    calculatorUrl: "",
    notes: "+6.0～+30.0D [0.5ステップ]"
  },
  // 4. ALCON / CNA0Tx / CNW0Tx (トーリック)
  {
    manufacturer: "ALCON",
    model: "CNA0Tx / CNW0Tx (トーリック)",
    id: "alcon-cna0tx-cnw0tx-toric",
    displayName: "ALCON / CNA0Tx / CNW0Tx (トーリック)",
    isToric: true,
    toricModels: [
      "CNA0T2",
      "CNA0T3",
      "CNA0T4",
      "CNA0T5",
      "CNA0T6",
      "CNW0T7",
      "CNW0T8",
      "CNW0T9"
    ],
    powerRange: { min: 6.0, max: 30.0, step: 0.5, default: 20.0 },
    calculatorUrl: "https://www.myalcon-toriccalc.com",
    notes: "+6.0～+30.0D [0.5ステップ]"
  },
  // 5. SANTEN / NX-70S
  {
    manufacturer: "SANTEN",
    model: "NX-70S",
    id: "santen-nx-70s",
    displayName: "SANTEN / NX-70S",
    isToric: false,
    toricModels: [],
    powerRange: { min: 10.0, max: 27.0, step: 0.5, default: 20.0 },
    calculatorUrl: "",
    notes: "+10.0～+27.0D [0.5ステップ]"
  },
  // 6. SANTEN / LS-313MF15
  {
    manufacturer: "SANTEN",
    model: "LS-313MF15",
    id: "santen-ls-313mf15",
    displayName: "SANTEN / LS-313MF15",
    isToric: false,
    toricModels: [],
    powerRange: { min: 10.0, max: 27.0, step: 0.5, default: 20.0 },
    calculatorUrl: "",
    notes: "+10.0～+27.0D [0.5ステップ]"
  },
  // 7. SANTEN / LS-313MF15 Tx (トーリック)
  {
    manufacturer: "SANTEN",
    model: "LS-313MF15 Tx (トーリック)",
    id: "santen-ls-313mf15-tx-toric",
    displayName: "SANTEN / LS-313MF15 Tx (トーリック)",
    isToric: true,
    toricModels: [
      "LS-313MF15 T1",
      "LS-313MF15 T2",
      "LS-313MF15 T3"
    ],
    powerRange: { min: 10.0, max: 27.0, step: 0.5, default: 20.0 },
    calculatorUrl: "https://www.teleon-toric.com",
    notes: "+10.0～+27.0D [0.5ステップ]"
  },
  // 8. NIDEK / NSP-2
  {
    manufacturer: "NIDEK",
    model: "NSP-2",
    id: "nidek-nsp-2",
    displayName: "NIDEK / NSP-2",
    isToric: false,
    toricModels: [],
    powerRange: {
      min: 1.0,
      max: 30.0,
      step: 0.5,
      default: 20.0,
      customSegments: [
        { min: 1.0, max: 5.0, step: 1.0 },
        { min: 5.0, max: 27.0, step: 0.5 },
        { min: 27.0, max: 30.0, step: 1.0 }
      ]
    },
    calculatorUrl: "",
    notes: "+1.0～+5.0D [1.0ステップ] / +5.0～+27.0D [0.5ステップ] / +27.0～+30.0D [1.0ステップ]"
  },
  // 9. NIDEK / NP-Tx (トーリック)
  {
    manufacturer: "NIDEK",
    model: "NP-Tx (トーリック)",
    id: "nidek-np-tx-toric",
    displayName: "NIDEK / NP-Tx (トーリック)",
    isToric: true,
    toricModels: [
      "NP-T3",
      "NP-T4",
      "NP-T5",
      "NP-T6",
      "NP-T7"
    ],
    powerRange: {
      min: 1.0,
      max: 30.0,
      step: 0.5,
      default: 20.0,
      customSegments: [
        { min: 1.0, max: 5.0, step: 1.0 },
        { min: 5.0, max: 27.0, step: 0.5 },
        { min: 27.0, max: 30.0, step: 1.0 }
      ]
    },
    calculatorUrl: "",
    notes: "+1.0～+5.0D [1.0ステップ] / +5.0～+27.0D [0.5ステップ] / +27.0～+30.0D [1.0ステップ]"
  },
  // 10. HOYA / XY1
  {
    manufacturer: "HOYA",
    model: "XY1",
    id: "hoya-xy1",
    displayName: "HOYA / XY1",
    isToric: false,
    toricModels: [],
    powerRange: { min: 6.0, max: 30.0, step: 0.5, default: 20.0 },
    calculatorUrl: "",
    notes: "+6.0～+30.0D [0.5ステップ]"
  },
  // 11. HOYA / PY-60AD
  {
    manufacturer: "HOYA",
    model: "PY-60AD",
    id: "hoya-py-60ad",
    displayName: "HOYA / PY-60AD",
    isToric: false,
    toricModels: [],
    powerRange: { min: 6.0, max: 30.0, step: 0.5, default: 20.0 },
    calculatorUrl: "",
    notes: "+6.0～+30.0D [0.5ステップ]"
  },
  // 12. ALCON / MN60MA (イエロー)
  {
    manufacturer: "ALCON",
    model: "MN60MA (イエロー)",
    id: "alcon-mn60ma-yellow",
    displayName: "ALCON / MN60MA (イエロー)",
    isToric: false,
    toricModels: [],
    powerRange: { min: -5.0, max: 5.0, step: 1.0, default: 0.0 },
    calculatorUrl: "",
    notes: "-5.0～+5.0D [1.0ステップ]"
  }
];

// Google Formに登録されている全60個のIOLパワー選択肢 (完全一致)
export const GOOGLE_FORM_ALL_POWERS = [
  "-5.0D", "-4.0D", "-3.0D", "-2.0D", "-1.0D", "0D",
  "+1.0D", "+2.0D", "+3.0D", "+4.0D", "+5.0D", "+5.5D",
  "+6.0D", "+6.5D", "+7.0D", "+7.5D", "+8.0D", "+8.5D",
  "+9.0D", "+9.5D", "+10.0D", "+10.5D", "+11.0D", "+11.5D",
  "+12.0D", "+12.5D", "+13.0D", "+13.5D", "+14.0D", "+14.5D",
  "+15.0D", "+15.5D", "+16.0D", "+16.5D", "+17.0D", "+17.5D",
  "+18.0D", "+18.5D", "+19.0D", "+19.5D", "+20.0D", "+20.5D",
  "+21.0D", "+21.5D", "+22.0D", "+22.5D", "+23.0D", "+23.5D",
  "+24.0D", "+24.5D", "+25.0D", "+25.5D", "+26.0D", "+26.5D",
  "+27.0D", "+27.5D", "+28.0D", "+28.5D", "+29.0D", "+29.5D",
  "+30.0D"
];
