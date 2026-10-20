// Neutral fixture construction only. Expected values live independently in the
// verifier; this module contains no implementation of context evaluation.
module.exports = function fixture(shape, context) {
  const dims = Array.from({ length: shape.dimensions }, (_, i) => ({
    name: `l${i}`,
    sql: `l${i}`,
    type: 'string',
  }));
  const rows = Array.from(
    { length: shape.dimensions },
    (_, i) =>
      `(${i},${(i + 1) * 3 * (i % 2 ? 1 : -1)}::numeric,${dims
        .map((_, j) => (j === 8 ? 'NULL::text' : `'L${j}'::text`))
        .join(',')},'S'::text,'T'::text)`
  );
  const sql = `SELECT * FROM (VALUES ${rows.join(
    ','
  )}) AS fixture_rows(depth,value,${dims
    .map((d) => d.name)
    .join(',')},alt0,alt1)`;
  const measures = Array.from({ length: shape.measures }, (_, i) => ({
    name: `m${i}`,
    sql: 'value',
    type: 'sum',
  }));
  if (shape.context) {
    for (let i = 0; i < shape.dimensions; i++) {
      measures.push({
        name: `h${i}`,
        type: 'sum',
        sql: 'value',
        filters: [{ sql: `{CUBE}.depth=${i}` }],
      });
      measures.push({
        name: `g${i}`,
        type: 'sum',
        sql: `CASE WHEN {CUBE}.l${i} IS NOT NULL THEN {CUBE}.value END`,
        filters: [{ sql: `{CUBE}.depth=${i}` }],
      });
    }
    const choices = (prefix) =>
      Array.from({ length: shape.dimensions }, (_, i) => ({
        context: {
          deepest_grouped: dims.map((d) => `Bench.${d.name}`),
          equals: i,
        },
        sql: `{${prefix}${i}}`,
      }));
    const amount = { name: 'amount', type: 'number', multi_stage: true };
    if (context)
      amount.case = { when: choices('h'), else: { sql: 'NULL * {h0}' } };
    else amount.sql = `{h${shape.dimensions - 1}}`;
    measures.push(amount);
    if (context) {
      measures.push({
        name: 'padded',
        type: 'number',
        multi_stage: true,
        case: { when: choices('g'), else: { sql: 'NULL * {h0}' } },
      });
      measures.push({
        name: 'alternate',
        type: 'number',
        multi_stage: true,
        case: {
          when: [
            {
              context: {
                deepest_grouped: ['Bench.alt0', 'Bench.alt1'],
                equals: 1,
              },
              sql: '{h1}',
            },
          ],
          else: { sql: '{h0}' },
        },
      });
      measures.push({
        name: 'expanded',
        type: 'sum',
        multi_stage: true,
        sql: '{amount}',
        grain: { include: ['Bench.l9'] },
      });
      measures.push({
        name: 'reduced',
        type: 'number',
        multi_stage: true,
        sql: '{amount}',
        grain: { exclude: ['Bench.l9'] },
      });
      measures.push({
        name: 'kept',
        type: 'number',
        multi_stage: true,
        sql: '{amount}',
        grain: { keep_only: [] },
      });
    }
  }
  return {
    cubes: [
      {
        name: 'Bench',
        sql,
        dimensions: [
          ...dims,
          { name: 'depth', sql: 'depth', type: 'number' },
          { name: 'alt0', sql: 'alt0', type: 'string' },
          { name: 'alt1', sql: 'alt1', type: 'string' },
        ],
        measures,
      },
    ],
  };
};
