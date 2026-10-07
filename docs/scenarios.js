/* Artificial, independently calculated examples; never client data. */
(function (root) {
  "use strict";
  const csv = rows => rows.join("\n") + "\n";
  const scenarios = [
    {id: "business", name: "Операции и выплаты", expectedName: "operations.csv", actualName: "payouts.csv",
      description: "Искусственный пример: 8 совпадений, два расхождения в суммах, две пропущенные и две лишние записи. Общая разница — минус 80 ₽. Нулевые суммы не отменяют отсутствие записей.",
      expectedCSV: csv(["id,gross,commission,refund", "O001,1000,100,0", "O002,500,50,0", "O003,250,25,0", "O004,800,80,200", "O005,300,30,0", "O006,1200,120,0", "O007,100,10,0", "O008,600,60,0", "O009,400,40,0", "O010,700,70,0", "O011,200,20,30", "O012,10,0,10"]),
      actualCSV: csv(["id,actual_net", "O001,900", "O002,450", "O003,225", "O004,520", "O005,270", "O006,1080", "O007,90", "O008,540", "O009,340", "O010,645", "X001,75", "X002,0"])},
    {id: "cancellation", name: "Копейки и возвраты", expectedName: "operations-cents.csv", actualName: "payouts-cents.csv",
      description: "Общие суммы равны: 108,60 ₽. Но в одной строке недостаёт копейки, в другой лишняя копейка, ещё одной записи нет. Отрицательные суммы — искусственные корректировки, разрешённые арифметическим контрактом.",
      expectedCSV: csv(["id,gross,commission,refund", "C001,0.30,0.10,0.10", "C002,19.99,0.99,0", "C003,10,1,12", "C004,0,0,5", "C005,100,2.50,0", "C006,10,0,10"]),
      actualCSV: csv(["id,actual_net", "C001,0.10", "C002,18.99", "C003,-3.00", "C004,-5.00", "C005,97.51"])},
    {id: "duplicate", name: "Дубли: остановка проверки", expectedName: "operations-duplicate.csv", actualName: "payouts-duplicate.csv",
      description: "ID D002 повторяется в выплатах: строки 3 и 4. Сверка остановится, чтобы не выдать неоднозначный результат. Если это две частичные выплаты, нужно отдельное правило объединения; автоматически удалять дубль нельзя.",
      expectedCSV: csv(["id,gross,commission,refund", "D001,100,10,0", "D002,50,5,0"]),
      actualCSV: csv(["id,actual_net", "D001,90", "D002,45", "D002,45"])}
  ];
  root.DEMO_SCENARIOS = scenarios;
  if (typeof module !== "undefined" && module.exports) module.exports = scenarios;
})(typeof globalThis !== "undefined" ? globalThis : window);
