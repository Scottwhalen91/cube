// Synthetic compatibility controls; none declares the new context case.
cube('Snapshots', {
  sql: `SELECT (array_agg(daily ORDER BY day DESC))[1] AS closing, AVG(daily) AS daily_average, SUM(daily) AS original_sum
    FROM (SELECT day,SUM(value) AS daily FROM (VALUES (1,100::numeric),(1,200::numeric),(2,20::numeric),(2,30::numeric)) AS v(day,value) GROUP BY day) AS totals`,
  refreshKey: { sql: 'SELECT 1' },
  measures: {
    closing: { type: 'sum', sql: 'closing' },
    dailyAverage: { type: 'sum', sql: 'daily_average' },
    originalSum: { type: 'sum', sql: 'original_sum' },
  },
});
cube('ZeroPositions', {
  sql: `SELECT (array_agg(balance ORDER BY day DESC) FILTER (WHERE balance IS NOT NULL))[1] AS closing,
    AVG(balance) AS average, COUNT(balance) AS nonblank FROM
    (VALUES (1,300::numeric),(2,0::numeric),(3,NULL::numeric)) AS t(day,balance)`,
  refreshKey: { sql: 'SELECT 1' },
  measures: {
    closing: { type: 'sum', sql: 'closing' }, average: { type: 'sum', sql: 'average' }, nonblank: { type: 'sum', sql: 'nonblank' },
  },
});
cube('Flows', {
  sql: `SELECT * FROM (VALUES (1,10::numeric),(2,20::numeric)) AS t(day,value)`,
  refreshKey: { sql: 'SELECT 1' },
  measures: {
    selectedSum: { type: 'sum', sql: 'value' },
    legacyCurrent: { type: 'sum', sql: 'value', filters: [{ sql: `${CUBE}.day=2` }] },
  },
  dimensions: { day: { sql: 'day', type: 'number' } },
});
cube('Credit', {
  sql: `SELECT * FROM (VALUES (1,'a','C','X',0.01::numeric,100::numeric,900::numeric),
    (2,'b','C','X',0.10::numeric,900::numeric,100::numeric)) AS t(id,book,customer,contract,pd,exposure,ead)`,
  refreshKey: { sql: 'SELECT 1' },
  measures: {
    exposure: { type:'sum', sql:'exposure' }, ead: { type:'sum', sql:'ead' },
    pdEad: { type:'sum', sql:'pd * ead' }, pdExposure: { type:'sum', sql:'pd * exposure' },
    weightedEad: { type:'number', sql:`${pdEad} / NULLIF(${ead},0)` },
    weightedExposure: { type:'number', sql:`${pdExposure} / NULLIF(${exposure},0)` },
    customers: { type:'countDistinct', sql:'customer' },
    contracts: { type:'countDistinct', sql:"book || ':' || contract" },
  },
  dimensions: { id:{sql:'id',type:'number',primaryKey:true}, book:{sql:'book',type:'string'} },
});
cube('Denominators', {
  sql: `SELECT * FROM (VALUES ('blank',NULL::numeric),('zero',0::numeric)) AS t(kind,value)`,
  refreshKey:{sql:'SELECT 1'},
  measures:{fallback:{type:'sum',sql:'COALESCE(value,1)'}},
  dimensions:{kind:{sql:'kind',type:'string'}},
});
cube('Population', {
  sql: `SELECT 'C1'::text AS customer, 'P2'::text AS product`,
  refreshKey:{sql:'SELECT 1'},
  measures:{count:{type:'count'}},
  dimensions:{customer:{sql:'customer',type:'string'},product:{sql:'product',type:'string'}},
});
cube('Converted', {
  sql: `SELECT * FROM (VALUES (1,10::numeric,1.5::numeric),(2,-20::numeric,2::numeric)) AS t(id,value,fx)`,
  refreshKey:{sql:'SELECT 1'},
  measures:{value:{type:'sum',sql:'value * fx'}},
});
