"use strict";
(() => {
const E = window.ReconciliationEngine;
const scenarios = window.DEMO_SCENARIOS;
const $ = id => document.getElementById(id);
let report = null, filter = 'all', page = 0, epoch = 0, sourceButton = null;
const filterChoice = $('filter-choice');
const PAGE_SIZE = 100;
const urls = new Map();
const labels = {matched:'Совпало', mismatch:'Суммы расходятся', missing:'Нет выплаты', unexpected:'Нет ожидания'};
const encoder = new TextEncoder();
function displayMoney(value) {
  return E.formatMoney(value).replace(/\u00a0/g,' ').replace(/ ₽$/,'\u00a0₽');
}
function downloadable(id, content, type, name) {
  const element = $(id);
  if (!element) return;
  if (urls.has(id)) URL.revokeObjectURL(urls.get(id));
  const url = URL.createObjectURL(new Blob([content], {type}));
  urls.set(id, url);
  element.setAttribute('href', url);
  element.setAttribute('download', name);
  element.removeAttribute('disabled');
  element.removeAttribute('aria-disabled');
}
function reset() {
  report = null;
  $('results-region').hidden = true;
  $('source-panel').hidden = true;
  $('input-error').hidden = true;
  sourceButton = null;
  for (const id of ['download-report','download-csv','download-expected','download-actual']) {
    const element = $(id);
    element.setAttribute('disabled','');
    element.setAttribute('aria-disabled','true');
    element.removeAttribute('href');
    if (urls.has(id)) {URL.revokeObjectURL(urls.get(id)); urls.delete(id);}
  }
}
function source(entry, button) {
  if (sourceButton) sourceButton.setAttribute('aria-expanded','false');
  sourceButton = button;
  button.setAttribute('aria-expanded','true');
  $('source-title').textContent = 'Исходные строки: ' + entry.id;
  let explanation = $('source-explanation');
  if (!explanation) {
    explanation = document.createElement('p');
    explanation.id = 'source-explanation';
    $('source-values').before(explanation);
  }
  const expected = entry.expected_source;
  const actual = entry.actual_source;
  let text = expected
    ? `Ожидается ${E.formatMoney(entry.expected_net)}: выручка минус комиссия и возврат. Файл «${expected.path}», строка ${expected.line_start}.`
    : 'В ожидаемой выгрузке этой операции нет.';
  text += actual
    ? ` В файле выплат «${actual.path}», строка ${actual.line_start}: ${E.formatMoney(entry.actual_net)}.`
    : ' В выгрузке выплат строка отсутствует.';
  text += ' Разница: ' + E.formatMoney(entry.delta) + '.';
  explanation.textContent = text;
  $('source-values').textContent = JSON.stringify({expected,actual},null,2);
  $('source-panel').hidden = false;
  $('source-panel').focus();
}
function filtered() {
  return report ? report.entries.filter(e => filter === 'all' || (filter === 'issues' ? e.status !== 'matched' : e.status === filter)) : [];
}
function pagination() {
  let nav = $('pagination');
  if (!nav) {
    nav = document.createElement('div');
    nav.id = 'pagination';
    nav.className = 'pagination';
    nav.setAttribute('role','group');
    nav.setAttribute('aria-label','Страницы отчёта');
    for (const [id,label,offset] of [['previous-page','Назад',-1],['next-page','Дальше',1]]) {
      const button = document.createElement('button');
      button.id = id;
      button.textContent = label;
      button.onclick = () => {page += offset; render();};
      nav.append(button);
    }
    $('count').parentElement.append(nav);
  }
  return nav;
}
function render() {
  const entries = filtered();
  page = Math.max(0, Math.min(page, Math.max(0, Math.ceil(entries.length/PAGE_SIZE)-1)));
  const first = page * PAGE_SIZE;
  const visible = entries.slice(first,first+PAGE_SIZE);
  const rows = document.createDocumentFragment();
  for (const entry of visible) {
    const tr = document.createElement('tr');
    tr.setAttribute('role','row');
    for (const value of [entry.id,labels[entry.status],displayMoney(entry.expected_net),displayMoney(entry.actual_net),displayMoney(entry.delta)]) {
      const column = tr.children.length;
      const td = document.createElement('td');
      td.setAttribute('role','cell');
      td.textContent = value;
      if (column === 1) {
        const badge = document.createElement('span');
        badge.className = 'status ' + entry.status;
        badge.textContent = value;
        td.replaceChildren(badge);
      }
      if (column >= 2) {
        const label = document.createElement('span');
        label.className = 'cell-label';
        label.setAttribute('aria-hidden','true');
        label.textContent = ['Ожидается','Выплачено','Разница'][column-2];
        const amount = document.createElement('span');
        amount.className = 'cell-money';
        amount.textContent = value;
        td.replaceChildren(label,amount);
      }
      tr.append(td);
    }
    const td = document.createElement('td');
    td.setAttribute('role','cell');
    const button = document.createElement('button');
    button.className = 'row-source';
    button.textContent = 'Исходные строки';
    button.setAttribute('aria-label','Исходные строки операции ' + entry.id);
    button.setAttribute('aria-controls','source-panel');
    button.setAttribute('aria-expanded','false');
    button.onclick = () => source(entry,button);
    td.append(button); tr.append(td); rows.append(tr);
  }
  $('rows').replaceChildren(rows);
  $('count').textContent = entries.length
    ? `Строки ${first+1}–${first+visible.length} из ${entries.length}. Всего в сверке: ${report.entries.length}.`
    : 'Для выбранного фильтра строк нет.';
  const nav = pagination(); nav.hidden = entries.length <= PAGE_SIZE;
  $('previous-page').disabled = page === 0;
  $('next-page').disabled = first + PAGE_SIZE >= entries.length;
  $('source-panel').hidden = true; sourceButton = null;
}
function show(result, expectedBytes, actualBytes, names, title) {
  report = result; filter = result.entries.some(entry => entry.status !== 'matched') ? 'issues' : 'all'; page = 0;
  for (const [id,key] of Object.entries({expected:'expected_net',actual:'actual_net',delta:'delta',under:'underpayment',over:'overpayment'})) {
    // Перенос между группами разрядов; валюта остаётся рядом с последней группой.
    const amount = displayMoney(report.totals[key]);
    $(id).textContent = amount;
    const metric = $(id).closest('.metric');
    if (metric) {
      $(id).classList.toggle('long-amount',amount.length > 16);
      metric.classList.toggle('has-long-amount',amount.length > 16);
    }
  }
  $('operation-count').textContent = report.entries.length + ' операций';
  const issues = report.counts.mismatch + report.counts.missing + report.counts.unexpected;
  $('input-status').textContent = `${title}. Проверено ${report.entries.length} операций, требуют внимания: ${issues}.`;
  for (const button of document.querySelectorAll('[data-filter]')) button.setAttribute('aria-pressed',String(button.dataset.filter===filter));
  if (filterChoice) filterChoice.value = filter;
  downloadable('download-report',JSON.stringify(report,null,2)+'\n','application/json;charset=utf-8','reconciliation-report.json');
  downloadable('download-csv',E.toCSV(report),'text/csv;charset=utf-8','reconciliation-report.csv');
  downloadable('download-expected',expectedBytes,'text/csv;charset=utf-8',names.expected);
  downloadable('download-actual',actualBytes,'text/csv;charset=utf-8',names.actual);
  $('input-error').hidden = true;
  $('results-region').hidden = false;
  render();
}
async function compute(expectedBytes,actualBytes,names,title) {
  const turn = ++epoch;
  reset(); $('input-status').textContent = 'Проверяю файлы и считаю расхождения…';
  try {
    const result = await E.reconcile(expectedBytes,actualBytes,names);
    if (turn !== epoch) return;
    show(result,expectedBytes,actualBytes,names,title);
  } catch (error) {
    if (turn !== epoch) return;
    $('input-error').textContent = error.message || 'Не удалось проверить входные данные.';
    $('input-error').hidden = false;
    $('input-status').textContent = 'Сверка остановлена. Исправьте данные или выберите другой пример.';
  }
}
async function preset() {
  const scenario = scenarios.find(s => s.id === $('scenario').value) || scenarios[0];
  $('expected-file').value = ''; $('actual-file').value = '';
  $('run-reconciliation').setAttribute('disabled','');
  return compute(encoder.encode(scenario.expectedCSV),encoder.encode(scenario.actualCSV),
    {expected:scenario.expectedName || 'expected.csv',actual:scenario.actualName || 'actual.csv'},scenario.name);
}
$('scenario').addEventListener('change',preset);
for (const id of ['expected-file','actual-file']) $(id).addEventListener('change',() => {
  ++epoch; reset();
  const ready = $('expected-file').files.length && $('actual-file').files.length;
  $('run-reconciliation').toggleAttribute('disabled',!ready);
  $('input-status').textContent = ready ? 'Файлы выбраны. Нажмите «Сверить файлы».' : 'Выберите обе выгрузки в формате CSV.';
});
$('run-reconciliation').onclick = async () => {
  const expected = $('expected-file').files[0], actual = $('actual-file').files[0];
  if (!expected || !actual) return;
  if (expected.size > 5*1024*1024 || actual.size > 5*1024*1024) {
    ++epoch; reset(); $('input-error').textContent = 'Каждый файл должен быть не больше 5 МиБ.';
    $('input-error').hidden = false; $('input-status').textContent = 'Сверка остановлена.'; return;
  }
  const turn = ++epoch; reset(); $('input-status').textContent = 'Читаю выбранные файлы…';
  try {
    const [a,b] = await Promise.all([expected.arrayBuffer(),actual.arrayBuffer()]);
    if (turn !== epoch) return;
    await compute(new Uint8Array(a),new Uint8Array(b),{expected:expected.name,actual:actual.name},'Ваши файлы');
  } catch (error) {
    if (turn !== epoch) return;
    $('input-error').textContent = error.message || 'Не удалось прочитать файл.';
    $('input-error').hidden = false; $('input-status').textContent = 'Сверка остановлена.';
  }
};
function chooseFilter(value) {
  if (!report) return;
  filter = value; page = 0;
  for (const button of document.querySelectorAll('[data-filter]')) button.setAttribute('aria-pressed',String(button.dataset.filter===filter));
  if (filterChoice) filterChoice.value = filter;
  render();
}
for (const button of document.querySelectorAll('[data-filter]')) button.onclick = () => chooseFilter(button.dataset.filter);
if (filterChoice) filterChoice.onchange = () => chooseFilter(filterChoice.value);
$('close-source').onclick = () => {
  $('source-panel').hidden = true;
  if (sourceButton) {sourceButton.setAttribute('aria-expanded','false');sourceButton.focus();}
};
window.addEventListener('pagehide',()=>{for(const url of urls.values()) URL.revokeObjectURL(url);});
if (!E || !Array.isArray(scenarios) || !scenarios.length) {
  reset(); $('input-error').textContent = 'Не удалось загрузить расчёт. Обновите страницу или откройте инструкцию в GitHub.';
  $('input-error').hidden = false;
} else preset();
})();
