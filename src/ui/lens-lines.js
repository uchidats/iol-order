import { GOOGLE_FORM_ALL_POWERS } from "../data/iol-models.js";
import { filterPowersByModel, defaultPowerLabel } from "../domain/power-filter.js";
import { filterLensOptions, findLensOption } from "../domain/lens-options.js";
import { MAX_LINES, findDuplicateLines } from "../domain/order-lines.js";

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

let seq = 0; // ラベルの for / radio の name を明細ごとに一意にする

/**
 * レンズの明細(複数)の入力欄。各明細が、多焦点・トーリックの絞り込み、IOLモデル、IOLパワー、枚数、手術日を持つ。
 * 絞り込みと度数の制限は明細ごとに独立して働く(モデルを変えたら、その明細の対応しない度数の選択は残らない)。
 *
 * @param {object} deps
 * @param {HTMLElement} deps.container 明細を並べる場所
 * @param {HTMLElement} deps.addButton 「レンズを追加」ボタン
 * @param {() => Array<object>} deps.getOptions 採用済みIOLの選択肢(buildLensOptions の結果)
 * @param {() => string} deps.minDate 手術日の最小値(YYYY-MM-DD)
 * @param {() => void} [deps.onChange] 内容が変わったとき(例: 計算ツール案内の更新)
 */
export function createLensLines({ container, addButton, getOptions, minDate, onChange = () => {} }) {
  const lines = [];

  function buildLine(prefill = {}) {
    const n = ++seq;
    const id = (s) => `${s}-${n}`;
    const line = { n };
    line.chkMf = h("input", { type: "checkbox", "data-f": "multifocal" });
    line.chkToric = h("input", { type: "checkbox", "data-f": "toric" });
    line.model = h("select", { id: id("lensModel"), class: "form-control", "data-f": "model" }, h("option", { value: "" }, "選択してください"));
    line.power = h("select", { id: id("lensPower"), class: "form-control", "data-f": "power" }, h("option", { value: "" }, "選択してください"));
    line.date = h("input", { id: id("lensDate"), type: "date", class: "form-control", "data-f": "date" });
    line.date.min = minDate();
    if (prefill.surgeryDate) line.date.value = prefill.surgeryDate; // 直前の明細の手術日を引き継ぐ(変更可)
    line.qty = [1, 2].map(q => h("input", { type: "radio", name: `lensQty-${n}`, value: String(q), "data-f": "quantity" }));
    line.qty[0].checked = true;
    line.errs = {};
    const err = (k) => (line.errs[k] = h("p", { class: "error-message", "data-err": k }));
    line.title = h("strong", { class: "lens-line-title" });
    line.removeBtn = h("button", { type: "button", class: "btn btn-outline-sm", "data-act": "remove" }, "削除");

    const group = (labelText, control, errKey, forId) => h("div", { class: "form-group", "data-group": errKey },
      h("label", { class: "form-label required", for: forId }, labelText, " ", h("span", { class: "badge-required" }, "必須")),
      control, err(errKey));

    line.root = h("fieldset", { class: "lens-line", "data-line": String(n) },
      h("div", { class: "lens-line-head" }, line.title, line.removeBtn),
      h("div", { class: "lens-filter", role: "group", "aria-label": "レンズの種類" },
        h("label", { class: "lens-filter-check" }, line.chkMf, " 多焦点"),
        h("label", { class: "lens-filter-check" }, line.chkToric, " トーリック")),
      group("IOLモデル", h("div", { class: "select-wrapper" }, line.model), "model", id("lensModel")),
      group("IOLパワー", h("div", { class: "select-wrapper" }, line.power), "power", id("lensPower")),
      h("div", { class: "form-group", "data-group": "quantity" },
        h("span", { class: "form-label required" }, "枚数 ", h("span", { class: "badge-required" }, "必須")),
        h("div", { class: "quantity-selector", role: "radiogroup", "aria-label": "枚数選択" },
          line.qty.map(r => h("label", { class: "quantity-option" }, r, h("span", { class: "quantity-btn" }, `${r.value} 枚`)))),
        err("quantity")),
      group("手術日", h("div", { class: "date-input-wrapper" }, line.date), "date", id("lensDate")));

    line.model.addEventListener("change", () => { clearErr(line, "model"); onModelChange(line); onChange(); });
    line.power.addEventListener("change", () => clearErr(line, "power"));
    line.date.addEventListener("change", () => clearErr(line, "date"));
    line.qty.forEach(r => r.addEventListener("change", () => clearErr(line, "quantity")));
    const onFilter = () => { rebuildModels(line, line.model.value); onChange(); };
    line.chkMf.addEventListener("change", onFilter);
    line.chkToric.addEventListener("change", onFilter);
    line.removeBtn.addEventListener("click", () => removeLine(line));
    return line;
  }

  const clearErr = (line, k) => { line.errs[k].textContent = ""; (k === "model" ? line.model : k === "power" ? line.power : k === "date" ? line.date : null)?.classList.remove("is-invalid"); };
  const setErr = (line, k, msg, ctl) => { line.errs[k].textContent = msg; ctl?.classList.add("is-invalid"); };

  /** 絞り込み後の選択肢でIOLモデルを作り直す。選択が外れたら、モデルとパワーを持ち越さない */
  function rebuildModels(line, prevKey = "") {
    const shown = filterLensOptions(getOptions(), { multifocal: line.chkMf.checked, toric: line.chkToric.checked });
    while (line.model.children.length > 1) line.model.removeChild(line.model.lastChild);
    line.model.firstElementChild.textContent = shown.length ? "選択してください" : "該当するIOLがありません";
    const byMaker = new Map();
    shown.forEach(o => { if (!byMaker.has(o.manufacturer)) byMaker.set(o.manufacturer, []); byMaker.get(o.manufacturer).push(o); });
    byMaker.forEach((list, maker) => {
      const group = h("optgroup", { label: maker });
      list.forEach(o => group.appendChild(h("option", { value: o.key }, o.label)));
      line.model.appendChild(group);
    });
    const kept = shown.some(o => o.key === prevKey);
    line.model.value = kept ? prevKey : "";
    if (prevKey && !kept) line.power.value = "";
    onModelChange(line);
  }

  /** モデルに応じて度数候補を作り直す。直前の度数が新しい候補に無ければ、既定値に戻す */
  function onModelChange(line) {
    const lens = findLensOption(getOptions(), line.model.value);
    const powers = lens ? filterPowersByModel(lens.model) : GOOGLE_FORM_ALL_POWERS;
    const def = lens ? defaultPowerLabel(lens.model) : "+20.0D";
    const prev = line.power.value;
    while (line.power.children.length > 1) line.power.removeChild(line.power.lastChild);
    powers.forEach(p => line.power.appendChild(h("option", { value: p }, p)));
    line.power.value = prev && powers.includes(prev) ? prev : (powers.includes(def) ? def : "");
  }

  function renumber() {
    lines.forEach((l, i) => { l.title.textContent = `レンズ ${i + 1}`; l.removeBtn.hidden = lines.length <= 1; });
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

  function removeLine(line) {
    if (lines.length <= 1) return;
    if (!window.confirm(`${line.title.textContent} を削除しますか？`)) return;
    lines.splice(lines.indexOf(line), 1);
    line.root.remove();
    renumber();
    onChange();
  }

  addButton.addEventListener("click", () => {
    const last = lines[lines.length - 1];
    const added = addLine({ surgeryDate: last ? last.date.value : "" });
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
        surgeryDate: l.date.value
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
        v.surgeryDate ? clearErr(l, "date") : fail("date", "手術日を選択してください", l.date);
      });
      // 同じレンズ・度数・手術日の重複(枚数で指定する)
      if (!first) {
        for (const i of findDuplicateLines(vals)) {
          setErr(lines[i], "model", "同じレンズ・度数・手術日の明細が重複しています。枚数で指定してください", lines[i].model);
          if (!first) first = lines[i].model;
        }
      }
      return { ok: !first, firstInvalid: first };
    },
    refresh() { lines.forEach(l => rebuildModels(l, l.model.value)); },
    /** 初期状態(1明細・両チェックOFF)に戻す */
    reset() {
      lines.splice(0).forEach(l => l.root.remove());
      addLine();
    },
    isDirty() { return lines.some(l => l.model.value || l.date.value); },
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
