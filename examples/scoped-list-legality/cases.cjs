// Fixed synthetic relations and SQL examples, not an optimizer or SQL recognizer.
const days = Array.from(
  { length: 12 },
  (_, i) => `2025-01-${String(i + 1).padStart(2, '0')}`
);
const quote = (value) =>
  value == null
    ? 'NULL'
    : typeof value === 'number'
    ? String(value)
    : "'" + value.replace(/'/g, "''") + "'";
function relation(name, columns, types, rows) {
  return `${name}(${columns.join(',')}) AS (${
    rows.length
      ? 'VALUES ' +
        rows
          .map(
            (row) =>
              '(' +
              row.map((v, i) => quote(v) + '::' + types[i]).join(',') +
              ')'
          )
          .join(',')
      : 'SELECT ' +
        types.map((type) => 'NULL::' + type).join(',') +
        ' WHERE FALSE'
  })`;
}
function source({
  facts = [],
  anchors = [
    ['red', 1],
    ['blue', 2],
  ],
  nullKey = false,
  duplicateKey = false,
} = {}) {
  return (
    'WITH ' +
    [
      relation(
        'offered',
        ['day'],
        ['date'],
        [
          ...days.map((d) => [d]),
          ...(nullKey ? [[null]] : []),
          ...(duplicateKey ? [[days[0]]] : []),
        ]
      ),
      relation('anchors', ['tenant', 'key'], ['text', 'integer'], anchors),
      relation(
        'facts',
        ['id', 'tenant', 'key', 'event_day', 'product', 'flag', 'amount'],
        ['integer', 'text', 'integer', 'date', 'text', 'integer', 'numeric'],
        facts
      ),
    ].join(',\n')
  );
}
const right =
  'anchors a LEFT JOIN facts f ON a.key = f.key AND a.tenant = f.tenant';
const predicate = "a.tenant = 'red' AND (f.product = 'P' OR f.product IS NULL)";
const projection =
  "to_char(d.day,'YYYY-MM-DD') AS offered_key, 1 AS cell_count";
const suffix = ' GROUP BY d.day ORDER BY d.day NULLS LAST';
function original(
  cte,
  where = predicate,
  select = projection,
  ending = suffix
) {
  return `${cte} SELECT ${select} FROM offered d CROSS JOIN (${right}) WHERE ${where}${ending}`;
}
function exists(cte, where = predicate, from = right, select = projection) {
  return `${cte} SELECT ${select} FROM offered d WHERE EXISTS (SELECT 1 FROM ${from} WHERE ${where})${suffix}`;
}
const p = [1, 'red', 1, days[1], 'P', 0, 3];
const q = [2, 'red', 1, days[4], 'P', 0, 7];
const corr = predicate + ' AND f.event_day = d.day';
const cases = [
  { name: 'independent offered side', cte: source({ facts: [p] }), keys: days },
  {
    name: 'empty facts retain null-extended anchor',
    cte: source(),
    keys: days,
  },
  {
    name: 'empty entire right relation',
    cte: source({ anchors: [] }),
    keys: [],
  },
  {
    name: 'nonqualifying populated facts do not become blank outer rows',
    cte: source({ facts: [[1, 'red', 1, days[0], 'Q', 0, 2]] }),
    keys: [],
  },
  {
    name: 'NULL offered keys and duplicate/fanout rows',
    cte: source({ facts: [p, q], nullKey: true, duplicateKey: true }),
    keys: [...days, null],
  },
  {
    name: 'retain real offered-day correlation',
    cte: source({ facts: [p, q] }),
    where: corr,
    keys: [days[1], days[4]],
  },
  {
    name: 'business OR remains inside mandatory tenant predicate',
    cte: source({
      facts: [
        [1, 'red', 1, days[0], 'Q', 0, 2],
        [2, 'blue', 2, days[0], 'P', 1, 9],
      ],
    }),
    where: "a.tenant = 'red' AND (f.product = 'P' OR f.flag = 1)",
    keys: [],
  },
  {
    name: 'nullable correlation preserves SQL equality',
    cte: source({ facts: [[1, 'red', 1, null, 'P', 0, 3]], nullKey: true }),
    where: corr,
    keys: [],
  },
];
module.exports = {
  days,
  source,
  right,
  predicate,
  projection,
  suffix,
  original,
  exists,
  cases,
  p,
  q,
  corr,
};
