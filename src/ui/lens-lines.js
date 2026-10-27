import { GOOGLE_FORM_ALL_POWERS } from "../data/iol-models.js";
import { filterPowersByModel, keepPowerIfAvailable } from "../domain/power-filter.js";
import { filterLensOptions, findLensOption } from "../domain/lens-options.js";
import { MAX_LINES } from "../domain/order-lines.js";
import { dealerMode, resolveLineDealer } from "../domain/dealer-selection.js";
import { enhanceSelect } from "./custom-select.js";

/** 要素生成の小さなヘルパー(表示文字列は textContent で扱い、HTMLとして解釈しない) */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}

/** ゴミ箱アイコン(装飾。ボタンの aria-label で意味を伝える) */
function trashIcon() {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: "18", height: "18", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" })) svg.setAttribute(k, v);
  for (const d of ["M3 6h18", "M8 6V4h8v2", "M19 6l-1 14H6L5 6", "M10 11v6", "M14 11v6"]) {
    const p = document.createElementNS(NS, "path"); p.setAttribute("d", d); svg.appendChild(p);
  }
  return svg;
}


let seq = 0; // ラベルの for / radio の name を明細ごとに一意にする

/**
 * レンズの明細(複数)の入力欄。各明細が、多焦点・トーリックの絞り込み、IOLモデル、IOLパワー、枚数、手術日を持つ。
 * 絞り込みと度数の制限は明細ごとに独立して働く(モデルを変えたら、その明細の対応しない度数の選択は残らない)。
 *
 * @param {object} deps
 * @param {HTMLElement} deps.container 明細を並べる場所
 * @param {HTMLElement} deps.addButton 「レンズを追加」ボタン
 * @param {() => Array<object>} deps.getOptions 採用済みIOLの選択肢(buildLensOptions の結果)
 * @param {() => Array<{id:string, name:string, email?:string}>} deps.getDoctors 担当医(施設のマスター)
 * @param {() => string} [deps.getDefaultDoctorId] 担当医の初期値(ログインユーザー本人が担当医に紐づく場合のその担当医ID。なければ "")。最初の明細と、入力を初期状態に戻したときに使う。変更できる
 * @param {() => Array<{id:string, name:string, orderEmails?:string[]}>} [deps.getDealers] 施設の登録ディーラー。0社=発注先なし / 1社=自動選択 / 2社以上=明細ごとに選択必須
 * @param {() => string} deps.minDate 手術日の最小値(YYYY-MM-DD)
 * @param {() => string} [deps.maxDate] 手術日の最大値(YYYY-MM-DD。"" は上限なし)
 * @param {() => void} [deps.onChange] 内容が変わったとき(例: 計算ツール案内の更新・下書きの保存)
 * @param {(info:{lineNo:number, undo:()=>void}) => void} [deps.onLineRemoved] レンズを削除した(最後の1枚は空に戻した)とき。undo() で元に戻せる
 */
export function createLensLines({ container, addButton, getOptions, getDoctors, getDealers = () => [], getDefaultDoctorId = () => "", minDate, maxDate = () => "", onChange = () => {}, onLineRemoved = () => {} }) {
  const lines = [];

  function buildLine(prefill = {}) {
    const n = ++seq;
    const id = (s) => `${s}-${n}`;
    const line = { n };
    line.chkMf = h("input", { type: "checkbox", "data-f": "multifocal" });
    line.chkToric = h("input", { type: "checkbox", "data-f": "toric" });
    line.model = h("select", { id: id("lensModel"), class: "form-control", "data-f": "model" }, h("option", { value: "" }, "選択"));
    line.power = h("select", { id: id("lensPower"), class: "form-control", "data-f": "power" }, h("option", { value: "" }, "選択"));
    line.date = h("input", { id: id("lensDate"), type: "date", class: "form-control", "data-f": "date" });
    line.date.min = minDate();
    if (maxDate()) line.date.max = maxDate();
    if (prefill.surgeryDate) line.date.value = prefill.surgeryDate; // 直前の明細の手術日を引き継ぐ(変更可)
    line.doctor = h("select", { id: id("lensDoctor"), class: "form-control", "data-f": "doctor" }, h("option", { value: "" }, "選択"));
    // 「レンズを追加」では、直前の明細の担当医を引き継ぐ(変更可。引き継ぎを優先)。最初の明細・初期状態では、本人が担当医に紐づく場合は本人を初期値にする(変更可)
    fillDoctors(line, prefill.doctorId !== undefined ? prefill.doctorId : getDefaultDoctorId());
    line.dealer = h("select", { id: id("lensDealer"), class: "form-control", "data-f": "dealer" }, h("option", { value: "" }, "選択"));
    fillDealers(line, prefill.dealerId || ""); // 直前の明細の発注先を引き継ぐ(変更可)
    line.qty = [1, 2].map(q => h("input", { type: "radio", name: `lensQty-${n}`, value: String(q), "data-f": "quantity" }));
    line.qty[0].checked = true;
    line.errs = {};
    const err = (k) => (line.errs[k] = h("p", { class: "error-message", "data-err": k }));
    line.title = h("strong", { class: "lens-line-title" });
    // 各レンズカードの右上の、控えめなゴミ箱アイコン(確認ダイアログなし。削除すると「元に戻す」付きの通知が出る)
    line.removeBtn = h("button", { type: "button", class: "lens-line-trash", "data-act": "remove", title: "このレンズを削除", "aria-label": "このレンズを削除" }, trashIcon());

    // 必須の印: 項目名の右に小さな赤い「*」(読み上げでは「必須」)
    const requiredMark = () => [h("span", { class: "required-mark", "aria-hidden": "true" }, "*"), h("span", { class: "sr-only" }, "（必須）")];
    const group = (labelText, control, errKey, forId, extra = null) => h("div", { class: "form-group", "data-group": errKey },
      h("label", { class: "form-label required", for: forId }, h("span", {}, labelText, ...requiredMark()), extra),
      control, err(errKey));

    line.root = h("fieldset", { class: "lens-line", "data-line": String(n) },
      h("div", { class: "lens-line-head" }, line.title, line.removeBtn),
      h("div", { class: "lens-filter", role: "group", "aria-label": "レンズの種類" },
        h("label", { class: "lens-filter-check" }, line.chkToric, " トーリック"),
        h("label", { class: "lens-filter-check" }, line.chkMf, " 多焦点")),   // メーカー別の Calculator のリンクは出さない(下部の「各社Calculator 関連リンク」を使う)
      // 2行: [IOLモデル | IOLパワー] [枚数 | 手術日]。横幅が足りない画面では自然に縦に折り返す(CSS の flex-wrap)
      h("div", { class: "lens-row" },
        group("IOLモデル", h("div", { class: "select-wrapper" }, line.model), "model", id("lensModel")),   // 多焦点・トーリックのバッジは表示しない(絞り込みは上のチェックボックス)
        group("IOLパワー", h("div", { class: "select-wrapper" }, line.power), "power", id("lensPower"))),
      h("div", { class: "lens-row" },
        h("div", { class: "form-group", "data-group": "quantity" },
          h("span", { class: "form-label required" }, h("span", {}, "枚数", ...requiredMark())),
          h("div", { class: "quantity-selector", role: "radiogroup", "aria-label": "枚数選択" },
            line.qty.map(r => h("label", { class: "quantity-option" }, r, h("span", { class: "quantity-btn" }, `${r.value} 枚`)))),
          err("quantity")),
        group("手術日", h("div", { class: "date-input-wrapper" }, line.date), "date", id("lensDate"))),
      group("担当医", h("div", { class: "select-wrapper" }, line.doctor), "doctor", id("lensDoctor")),
      // 発注先: 施設の登録ディーラーが2社以上のときだけ表示(選択必須)。1社は自動、0社は「発注先未設定」
      group("発注先", h("div", { class: "select-wrapper" }, line.dealer), "dealer", id("lensDealer")));
    // スマホ幅では、モデルと度数の選択をカスタムドロップダウンで行う(select は値の保持用に残る。PC幅は従来のselect)
    enhanceSelect(line.model, { ariaLabel: "IOLモデル" });
    enhanceSelect(line.power, { ariaLabel: "IOLパワー", matchWidth: true });
    enhanceSelect(line.doctor, { ariaLabel: "担当医", matchWidth: true, wrapText: true });   // 担当医: 幅の狭い選択ボックス。展開メニューも同じ幅。長い名前は折り返す   // 度数は幅の狭い選択ボックス。展開メニューも同じ幅
    line.dealerGroup = line.root.querySelector('[data-group="dealer"]');
    syncDealerGroup(line);

    line.model.addEventListener("change", () => {
      line.model.title = line.model.value ? line.model.selectedOptions[0].title : ""; // メーカー込みの全文は、ホバーで確認できる
      clearErr(line, "model"); onModelChange(line); onChange();
    });
    line.power.addEventListener("change", () => clearErr(line, "power"));
    line.date.addEventListener("change", () => clearErr(line, "date"));
    // 幅が狭いPCのネイティブ select では、長い名前が切れて見えることがあるため、ホバーで全文を確認できるようにする
    const doctorTitle = () => { line.doctor.title = line.doctor.value && line.doctor.selectedOptions[0] ? line.doctor.selectedOptions[0].textContent : ""; };
    line.doctor.addEventListener("change", () => { clearErr(line, "doctor"); doctorTitle(); });
    doctorTitle();
    line.dealer.addEventListener("change", () => clearErr(line, "dealer"));
    line.qty.forEach(r => r.addEventListener("change", () => clearErr(line, "quantity")));
    const onFilter = () => { rebuildModels(line, line.model.value); onChange(); };
    line.chkMf.addEventListener("change", onFilter);
    line.chkToric.addEventListener("change", onFilter);
    line.removeBtn.addEventListener("click", () => removeLine(line));
    return line;
  }

  const clearErr = (line, k) => { line.errs[k].textContent = ""; (k === "model" ? line.model : k === "power" ? line.power : k === "date" ? line.date : k === "doctor" ? line.doctor : k === "dealer" ? line.dealer : null)?.classList.remove("is-invalid"); };

  /** 発注先の選択肢を作り直す。選択中のディーラーが登録に残っていれば維持し、無ければ未選択に戻す */
  function fillDealers(line, selectedId) {
    while (line.dealer.children.length > 1) line.dealer.removeChild(line.dealer.lastChild);
    for (const d of getDealers()) line.dealer.appendChild(h("option", { value: d.id }, d.name));
    line.dealer.value = [...line.dealer.options].some(o => o.value === selectedId) ? selectedId : "";
  }
  const syncDealerGroup = (line) => { if (line.dealerGroup) line.dealerGroup.hidden = dealerMode(getDealers()) !== "choose"; };

  /** 担当医の選択肢を作り直す。選択中の担当医がマスターに残っていれば維持し、無ければ未選択に戻す */
  function fillDoctors(line, selectedId) {
    while (line.doctor.children.length > 1) line.doctor.removeChild(line.doctor.lastChild);
    for (const d of getDoctors()) {
      const o = h("option", { value: d.id }, d.name);
      if (d.email) o.title = d.email;
      line.doctor.appendChild(o);
    }
    line.doctor.value = [...line.doctor.options].some(o => o.value === selectedId) ? selectedId : "";
    line.doctor.title = line.doctor.value && line.doctor.selectedOptions[0] ? line.doctor.selectedOptions[0].textContent : "";
  }
  const setErr = (line, k, msg, ctl) => { line.errs[k].textContent = msg; ctl?.classList.add("is-invalid"); };

  /** 絞り込み後の選択肢でIOLモデルを作り直す。選択が外れたら、モデルとパワーを持ち越さない */
  function rebuildModels(line, prevKey = "") {
    const shown = filterLensOptions(getOptions(), { multifocal: line.chkMf.checked, toric: line.chkToric.checked });
    while (line.model.children.length > 1) line.model.removeChild(line.model.lastChild);
    line.model.firstElementChild.textContent = shown.length ? "選択" : "該当するIOLがありません";
    const byMaker = new Map();
    shown.forEach(o => { if (!byMaker.has(o.manufacturer)) byMaker.set(o.manufacturer, []); byMaker.get(o.manufacturer).push(o); });
    // 一覧は型番(モデル名)だけ。メーカー名の見出し・グループの余白や区切り線は出さない。並び順は従来どおり(メーカーごとにまとまった順)。
    // メーカー込みの全文は title で確認できる。値(key)・絞り込み・注文データは変わらない
    byMaker.forEach((list) => {
      list.forEach(o => line.model.appendChild(h("option", { value: o.key, title: o.label }, o.shortLabel)));
    });
    const kept = shown.some(o => o.key === prevKey);
    line.model.value = kept ? prevKey : "";
    line.model.title = line.model.selectedOptions[0] && line.model.value ? line.model.selectedOptions[0].title : "";
    onModelChange(line); // 絞り込みでモデルが外れても、度数は「変更後に存在すれば維持」の原則で扱う
  }

  /**
   * モデルに応じて度数候補を作り直す(モデルごとの範囲・刻みの制限)。度数は自動で選ばない(初期表示は「選択」)。
   * モデルを変えたときは、変更前の度数が変更後のモデルにもあれば維持し、なければ未選択に戻す。必須チェックは validate() が行う。
   * 度数は +20.0D 付近が使われることが多いが、+20.0D を自動で確定することはしない。
   */
  function onModelChange(line) {
    const lens = findLensOption(getOptions(), line.model.value);
    const powers = lens ? filterPowersByModel(lens.model) : GOOGLE_FORM_ALL_POWERS;
    const prev = line.power.value;
    while (line.power.children.length > 1) line.power.removeChild(line.power.lastChild);
    powers.forEach(p => line.power.appendChild(h("option", { value: p }, p)));
    // 変更前の度数が、変更後のモデルの選択肢にもあれば維持し、なければ「選択」に戻す(未選択なら未選択のまま)。
    // モデルの変更でも、トーリック・多焦点の絞り込みによるモデルの変更でも、同じ原則
    line.power.value = keepPowerIfAvailable(prev, powers);
  }

  function renumber() {
    lines.forEach((l, i) => { l.title.textContent = `レンズ${i + 1}`; l.removeBtn.setAttribute("aria-label", `レンズ${i + 1}を削除`); l.removeBtn.title = `レンズ${i + 1}を削除`; });
    addButton.disabled = lines.length >= MAX_LINES;
  }

  function addLine(prefill) {
    if (lines.length >= MAX_LINES) return null;
    const line = buildLine(prefill);
    lines.push(line);
    container.appendChild(line.root);
    rebuildModels(line, "");
    renumber();
    onChange();
    return line;
  }

  /** 1明細の入力状態(下書きの保存・削除の「元に戻す」に使う) */
  function readState(line) {
    return {
      toric: line.chkToric.checked, multifocal: line.chkMf.checked, modelKey: line.model.value, power: line.power.value,
      quantity: parseInt((line.qty.find(r => r.checked) || {}).value || "1", 10),
      date: line.date.value, doctorId: line.doctor.value, dealerId: line.dealer.value
    };
  }

  /**
   * 入力状態を明細に反映する。モデル・度数・担当医・発注先は、今の選択肢に存在するものだけ(なければ未選択)。
   * 復元後も、モデルに対応しない度数は残らない(度数はモデルの選択肢の中から選ぶ)。必須チェックは validate() が行う。
   */
  function writeState(line, st = {}) {
    const lens = st.modelKey ? findLensOption(getOptions(), st.modelKey) : null;
    line.chkToric.checked = lens ? lens.isToric : st.toric === true;           // 選んだモデルが一覧に出る絞り込みにする
    line.chkMf.checked = lens ? lens.isMultifocal : st.multifocal === true;
    rebuildModels(line, st.modelKey || "");
    line.model.title = line.model.value && line.model.selectedOptions[0] ? line.model.selectedOptions[0].title : "";
    line.power.value = keepPowerIfAvailable(st.power || "", [...line.power.options].map(o => o.value).filter(Boolean));
    line.qty.forEach(r => { r.checked = r.value === String(st.quantity === 2 ? 2 : 1); });
    line.date.value = st.date && st.date >= minDate() ? st.date : "";           // 過去の日付は復元しない
    fillDoctors(line, st.doctorId || "");
    fillDealers(line, st.dealerId || "");
    syncDealerGroup(line);
    for (const k of ["model", "power", "quantity", "date", "doctor", "dealer"]) clearErr(line, k);
  }

  /** 削除した明細を、元の位置に戻す */
  function insertAt(index, state) {
    if (lines.length >= MAX_LINES) return;
    const line = buildLine({ doctorId: state.doctorId });
    lines.splice(index, 0, line);
    container.insertBefore(line.root, container.children[index] || null);
    rebuildModels(line, "");
    writeState(line, state);
  }

  /**
   * レンズを削除する(確認ダイアログなし。onLineRemoved の「元に戻す」で戻せる)。レンズ番号は残りで自動的に振り直される。
   * 最後の1枚は削除せず、空の入力カードに戻す。
   */
  function removeLine(line) {
    const index = lines.indexOf(line);
    if (index < 0) return;
    const state = readState(line);
    let undo;
    if (lines.length <= 1) {
      writeState(line, { doctorId: getDefaultDoctorId() });
      undo = () => writeState(line, state);
    } else {
      lines.splice(index, 1);
      line.root.remove();
      undo = () => insertAt(index, state);
    }
    renumber();
    onChange();
    onLineRemoved({ lineNo: index + 1, undo: () => { undo(); renumber(); onChange(); } });
  }

  addButton.addEventListener("click", () => {
    const last = lines[lines.length - 1];
    const added = addLine({ surgeryDate: last ? last.date.value : "", doctorId: last ? last.doctor.value : "", dealerId: last ? last.dealer.value : "" });
    if (added) added.model.focus();
  });

  addLine();

  return {
    /** 現在の入力内容(確認前の生の値) */
    values() {
      return lines.map(l => ({
        lens: findLensOption(getOptions(), l.model.value),
        power: l.power.value,
        quantity: parseInt((l.qty.find(r => r.checked) || {}).value || "0", 10),
        surgeryDate: l.date.value,
        doctor: getDoctors().find(d => d.id === l.doctor.value) || null,
        // 発注先: 1社なら自動、2社以上は選んだもの(未選択は null)、0社は null。判定はサーバーと同じ規則
        dealer: (() => { const r = resolveLineDealer(getDealers(), l.dealer.value); return r.ok ? r.dealer : null; })()
      }));
    },
    /** 全明細の入力検証。最初の不備の要素を返す */
    validate() {
      let first = null;
      const vals = this.values();
      lines.forEach((l, i) => {
        const v = vals[i];
        const fail = (k, msg, ctl) => { setErr(l, k, msg, ctl); if (!first && ctl) first = ctl; };
        v.lens ? clearErr(l, "model") : fail("model", "IOLモデルを選択してください", l.model);
        v.power ? clearErr(l, "power") : fail("power", "IOLパワー (ディオプター) を選択してください", l.power);
        v.quantity ? clearErr(l, "quantity") : fail("quantity", "枚数を選択してください", l.qty[0]);
        // 範囲はサーバーと同じ(日本時間の本日以降・1年以内。minDate / maxDate)
        if (!v.surgeryDate) fail("date", "手術日を選択してください", l.date);
        else if (v.surgeryDate < minDate()) fail("date", "手術日は本日以降を指定してください", l.date);
        else if (maxDate() && v.surgeryDate > maxDate()) fail("date", "手術日が先すぎます（1年以内で指定してください）", l.date);
        else clearErr(l, "date");
        v.doctor ? clearErr(l, "doctor") : fail("doctor", "担当医を選択してください", l.doctor);
        if (dealerMode(getDealers()) === "choose" && !v.dealer) fail("dealer", "発注先を選択してください", l.dealer); else clearErr(l, "dealer");
      });
      // 同じ条件の明細の重複は、入力の誤りにしない(確認画面で「重複を確認しました」にチェックすれば注文できる。order-form.js)
      return { ok: !first, firstInvalid: first };
    },
    refresh() { lines.forEach(l => { rebuildModels(l, l.model.value); fillDoctors(l, l.doctor.value); fillDealers(l, l.dealer.value); syncDealerGroup(l); }); },
    /** 全明細の入力状態(下書きの保存用) */
    snapshot() { return lines.map(readState); },
    /** 下書きの復元: 保存された状態から明細を作り直す(選択肢にないモデル・度数・担当医・発注先は未選択になる) */
    restore(states) {
      lines.splice(0).forEach(l => l.root.remove());
      const list = (Array.isArray(states) ? states : []).slice(0, MAX_LINES);
      if (!list.length) { addLine(); return; }
      list.forEach((st, i) => {
        const line = buildLine({ doctorId: st.doctorId });
        lines.push(line);
        container.appendChild(line.root);
        rebuildModels(line, "");
        writeState(line, st);
      });
      renumber();
      onChange();
    },
    /** 初期状態(1明細・両チェックOFF)に戻す */
    reset() {
      lines.splice(0).forEach(l => l.root.remove());
      addLine();
    },
    isDirty() { return lines.some(l => l.model.value || l.date.value || l.doctor.value); },
    count: () => lines.length,
    /** いずれかの明細が ALCON のトーリックなら、その計算ツールのURL(案内表示用) */
    alconCalculator() {
      for (const v of this.values()) {
        if (v.lens && v.lens.manufacturer === "ALCON" && v.lens.isToric) return v.lens.model.calculatorUrl || "";
      }
      return null;
    }
  };
}
