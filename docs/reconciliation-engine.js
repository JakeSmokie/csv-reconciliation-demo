/* Exact local CSV reconciliation. No network requests, account access or floating-point money. */
(function (root) {
  "use strict";
  const SCHEMAS = {expected: ["id", "gross", "commission", "refund"], actual: ["id", "actual_net"]};
  const MAX_BYTES = 5 * 1024 * 1024, MAX_ROWS = 100000;
  const MAX_CENTS = 99999999999999999n;
  const MONEY = /^[+-]?[0-9]+(?:\.[0-9]{1,2})?(?![\s\S])/;
  class InputError extends Error {
    constructor(message, code, details) {super(message); this.name = "InputError"; this.code = code; Object.assign(this, details || {});}
  }
  function fail(message, code, details) {throw new InputError(message, code, details);}
  function filename(name, fallback) {return String(name || fallback).split(/[\\/]/).pop() || fallback;}
  function asBytes(input) {
    if (typeof input === "string") return new TextEncoder().encode(input);
    if (ArrayBuffer.isView(input) && input.BYTES_PER_ELEMENT === 1) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (Object.prototype.toString.call(input) === "[object ArrayBuffer]") return new Uint8Array(input);
    fail("Нужен UTF-8 CSV: текст или массив байтов.", "input_type");
  }
  function cents(raw, where) {
    if (typeof raw !== "string" || !MONEY.test(raw)) fail(where + ": сумма должна быть числом с точкой и не более двух знаков после неё.", "money_format");
    const negative = raw[0] === "-", unsigned = raw.replace(/^[+-]/, ""), parts = unsigned.split(".");
    const whole = parts[0].replace(/^0+/, "") || "0";
    if (whole.length > 15) fail(where + ": сумма превышает допустимый предел.", "money_limit");
    let value = BigInt(whole) * 100n + BigInt((parts[1] || "").padEnd(2, "0"));
    if (value > MAX_CENTS) fail(where + ": сумма превышает допустимый предел.", "money_limit");
    return negative ? -value : value;
  }
  function money(value) {
    const negative = value < 0n; const absolute = negative ? -value : value;
    return (negative ? "-" : "") + String(absolute / 100n) + "." + String(absolute % 100n).padStart(2, "0");
  }
  function formatMoney(value) {
    const text = String(value), match = /^([+-]?)([0-9]+)(?:\.([0-9]{1,2}))?$/.exec(text);
    if (!match || match[0].length !== text.length) fail("Некорректная сумма для отображения.", "money_display");
    const whole = match[2].replace(/^0+/, "") || "0", fraction = (match[3] || "").padEnd(2, "0");
    const nonzero = /[1-9]/.test(whole + fraction);
    return (match[1] === "-" && nonzero ? "−" : "") + whole.replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0") + "," + fraction + " ₽";
  }
  // Python csv.reader accepts LF, CRLF and CR between records. Normalize only
  // outside quoted fields; embedded ID line breaks retain their exact identity.
  function normalizeRecordSeparators(text, name) {
    const parts = []; let quoted = false, fieldStart = true, start = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (quoted) {
        if (char === '"') {if (text[i + 1] === '"') i++; else {
          quoted = false;
          const next = text[i + 1];
          if (next !== undefined && next !== ',' && next !== '\r' && next !== '\n') {
            const line = breaks(text.slice(0, i)) + 1;
            fail(name + ': строка ' + line + ': после закрывающей кавычки нужен разделитель или конец записи.', 'csv_syntax', {file: name, line});
          }
        }}
      } else if (char === '"' && fieldStart) {quoted = true; fieldStart = false;}
      else if (char === ",") fieldStart = true;
      else if (char === "\r" || char === "\n") {
        parts.push(text.slice(start, i), "\n");
        if (char === "\r" && text[i + 1] === "\n") i++;
        start = i + 1; fieldStart = true;
      } else fieldStart = false;
    }
    parts.push(text.slice(start)); return parts.join("");
  }
  function breaks(text) {const matches = text.match(/\r\n|\r|\n/g); return matches ? matches.length : 0;}
  function papa() {
    if (root.Papa && root.Papa.parse) return root.Papa;
    if (typeof require === "function") return require("./vendor/papaparse-5.7.0/papaparse.min.js");
    fail("Парсер CSV не загрузился. Обновите страницу.", "parser_missing");
  }
  function parse(bytes, kind, name) {
    if (bytes.byteLength > MAX_BYTES) fail(name + ": файл больше 5 МиБ.", "file_limit");
    let decoded;
    try {decoded = new TextDecoder("utf-8", {fatal: true}).decode(bytes);}
    catch (_) {fail(name + ": нужен файл в UTF-8.", "encoding");}
    // TextDecoder removes one leading UTF-8 BOM, matching Python utf-8-sig.
    if (decoded.startsWith("\ufeff")) fail(name + ": лишний BOM перед заголовками CSV.", "schema");
    const text = normalizeRecordSeparators(decoded, name), schema = SCHEMAS[kind];
    const rows = new Map(); let previousCursor = 0, line = 1, headerSeen = false;
    papa().parse(text, {delimiter: ",", newline: "\n", quoteChar: '"', escapeChar: '"',
      header: false, dynamicTyping: false, skipEmptyLines: false, fastMode: false,
      step(result) {
        const cursor = result.meta.cursor, startCursor = previousCursor, startLine = line;
        const consumed = text.slice(startCursor, cursor);
        const body = consumed.endsWith("\n") ? consumed.slice(0, -1) : consumed;
        const endLine = startLine + breaks(body);
        previousCursor = cursor; line += breaks(consumed);
        if (result.errors && result.errors.length) fail(name + ": строка " + startLine + ": некорректные кавычки CSV.", "csv_syntax", {file: name, line: startLine});
        const cells = result.data;
        // Papa emits one artificial empty record after a final record separator.
        // A real blank record consumes a newline and must still be rejected.
        if (headerSeen && startCursor === text.length && cursor === text.length && text.endsWith("\n") && cells.length === 1 && cells[0] === "") return;
        if (!headerSeen) {
          headerSeen = true;
          if (cells.length !== schema.length || cells.some((cell, index) => cell !== schema[index])) fail(name + ": нужны заголовки точно в таком порядке: " + schema.join(",") + ".", "schema", {file: name, line: startLine});
          return;
        }
        if (cells.length !== schema.length) fail(name + ": строка " + startLine + ": ожидалось " + schema.length + " ячеек, получено " + cells.length + ".", "cell_count", {file: name, line: startLine});
        const key = cells[0];
        if (!key) fail(name + ": строка " + startLine + ": ID не может быть пустым.", "empty_id", {file: name, line: startLine});
        if (rows.has(key)) {const firstLine = rows.get(key).source.line_start;
          fail(name + ": ID «" + key + "» повторяется: строки " + firstLine + " и " + startLine + ". Проверьте дубль; частичные выплаты требуют отдельного правила объединения.", "duplicate_id", {file: name, line: startLine, firstLine, id: key});}
        if (rows.size >= MAX_ROWS) fail(name + ": максимум 100 000 записей на файл.", "row_limit");
        const original = {}, values = {};
        schema.forEach((field, index) => {original[field] = cells[index]; if (index) values[field] = cents(cells[index], name + ": строка " + startLine + ", " + field);});
        rows.set(key, {values, source: {path: name, line_start: startLine, line_end: endLine, values: original}});
      }});
    if (!headerSeen) fail(name + ": отсутствуют заголовки CSV.", "schema");
    return rows;
  }
  async function sha256(bytes) {
    let provider = root.crypto;
    if ((!provider || !provider.subtle) && typeof require === "function") provider = require("node:crypto").webcrypto;
    if (!provider || !provider.subtle) fail("Для SHA-256 нужен безопасный контекст браузера HTTPS.", "crypto_missing");
    const digest = await provider.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
  }
  async function reconcile(expectedInput, actualInput, names) {
    const expectedBytes = asBytes(expectedInput), actualBytes = asBytes(actualInput);
    const expectedName = filename(names && (names.expected || names.expectedName), "expected.csv");
    const actualName = filename(names && (names.actual || names.actualName), "actual.csv");
    const expected = parse(expectedBytes, "expected", expectedName), actual = parse(actualBytes, "actual", actualName);
    const counts = {matched: 0, mismatch: 0, missing: 0, unexpected: 0}; const entries = [];
    let gross = 0n, commission = 0n, refund = 0n, totalExpected = 0n, totalActual = 0n, under = 0n, over = 0n, entryDelta = 0n;
    const keys = [...expected.keys(), ...Array.from(actual.keys()).filter(key => !expected.has(key))];
    for (const key of keys) {
      const exp = expected.get(key), act = actual.get(key); let net = 0n;
      if (exp) {gross += exp.values.gross; commission += exp.values.commission; refund += exp.values.refund; net = exp.values.gross - exp.values.commission - exp.values.refund;}
      const paid = act ? act.values.actual_net : 0n, delta = paid - net;
      const status = !exp ? "unexpected" : !act ? "missing" : delta === 0n ? "matched" : "mismatch";
      counts[status]++; totalExpected += net; totalActual += paid; entryDelta += delta;
      if (delta < 0n) under -= delta; else over += delta;
      entries.push({id: key, status, expected_net: money(net), actual_net: money(paid), delta: money(delta), expected_source: exp ? exp.source : null, actual_source: act ? act.source : null});
    }
    const delta = totalActual - totalExpected;
    if (totalExpected !== gross - commission - refund || delta !== entryDelta || delta !== over - under) throw new Error("Нарушена проверка итоговых сумм.");
    const hashes = await Promise.all([sha256(expectedBytes), sha256(actualBytes)]);
    return {schema_version: 1, money_unit: "RUB", delta_definition: "actual - expected",
      inputs: {expected: {path: expectedName, sha256: hashes[0], rows: expected.size}, actual: {path: actualName, sha256: hashes[1], rows: actual.size}},
      counts, totals: {gross: money(gross), commission: money(commission), refund: money(refund), expected_net: money(totalExpected), actual_net: money(totalActual), delta: money(delta), underpayment: money(under), overpayment: money(over)},
      conservation_verified: true, entries};
  }
  function safeID(id) {return /^[=+\-@\s\p{Cc}\p{Cf}]/u.test(id) ? "'" + id : id;}
  function csvCell(value) {const text = String(value == null ? "" : value); return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;}
  function toCSV(report) {
    const fields = ["id", "status", "expected_net", "actual_net", "delta", "expected_line_start", "expected_line_end", "actual_line_start", "actual_line_end", "expected_source_values_json", "actual_source_values_json"];
    const lines = [fields.join(",")];
    for (const entry of report.entries) {
      const row = [safeID(entry.id), entry.status, entry.expected_net, entry.actual_net, entry.delta];
      for (const side of ["expected", "actual"]) {const source = entry[side + "_source"]; row.push(source ? source.line_start : "", source ? source.line_end : "");}
      for (const side of ["expected", "actual"]) {const source = entry[side + "_source"]; row.push(source ? JSON.stringify(source.values) : "");}
      lines.push(row.map(csvCell).join(","));
    }
    return "\ufeff" + lines.join("\r\n") + "\r\n";
  }
  const api = {reconcile, toCSV, formatMoney, InputError, MAX_BYTES, MAX_ROWS};
  root.ReconciliationEngine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
