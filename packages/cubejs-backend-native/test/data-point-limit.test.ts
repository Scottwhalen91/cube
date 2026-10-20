import {
  getFinalQueryResult, getFinalQueryResultMulti, ResultWrapper, ResultMultiWrapper,
  ResultArrayWrapper, rowsToColumnarBuffer,
} from '../js';

const parse = (buffer: ArrayBuffer) => JSON.parse(Buffer.from(buffer).toString());
const query = { dimensions: ['Neutral.category'], measures: ['Neutral.value'] };
const transform = (resType?: string) => ({
  aliasToMemberNameMap: { category: 'Neutral.category', value: 'Neutral.value' },
  annotation: { 'Neutral.category': { type: 'string' }, 'Neutral.value': { type: 'number' } },
  query,
  queryType: 'regularQuery',
  ...(resType ? { resType } : {}),
});
const root = () => ({ query, annotation: {}, slowQuery: false });
const rows = [
  { category: 'amount', value: 0 },
  { category: 'ratio', value: 0.25 },
  { category: '', value: null },
];
const raw = () => rowsToColumnarBuffer(rows);
const exceeded = { message: 'The query data point limit has been exceeded.', type: 'UserError' };

function wrapper() {
  const result = new ResultWrapper(rows);
  result.setTransformData(transform());
  result.setRootResultObject(root());
  return result;
}

describe('buffered load data point limit', () => {
  const original = process.env.CUBEJS_DB_QUERY_DATA_POINT_LIMIT;
  afterEach(() => {
    if (original === undefined) { delete process.env.CUBEJS_DB_QUERY_DATA_POINT_LIMIT; } else { process.env.CUBEJS_DB_QUERY_DATA_POINT_LIMIT = original; }
  });
  test.each([undefined, 'compact', 'columnar'])('counts NULL/blank/zero cells in %s output', async (format) => {
    const control = parse(await getFinalQueryResult(transform(format), raw(), root()));
    expect(parse(await getFinalQueryResult(transform(format), raw(), root(), 6))).toEqual(control);
    await expect(getFinalQueryResult(transform(format), raw(), root(), 5)).rejects.toMatchObject(exceeded);
    expect(parse(await getFinalQueryResult(transform(format), raw(), root()))).toEqual(control);
  });
  test('does not count annotation or root metadata', async () => {
    const result = parse(await getFinalQueryResult(transform(), raw(), { ...root(), annotation: { measures: { 'Neutral.value': { type: 'number', title: 'Uncounted metadata' } } }, total: 1000 }, 6));
    expect(result.data).toHaveLength(3);
    expect(result.total).toBe(1000);
  });
  test('zero rows consume zero cells and scalar rows consume their fields', async () => {
    const empty = parse(await getFinalQueryResult(transform(), rowsToColumnarBuffer([]), root(), 1));
    expect(empty.data).toEqual([]);
    const one = rowsToColumnarBuffer([{ category: 'one', value: 1 }]);
    await expect(getFinalQueryResult(transform(), one, root(), 1)).rejects.toMatchObject(exceeded);
    expect(parse(await getFinalQueryResult(transform(), one, root(), 2)).data).toHaveLength(1);
  });
  test('multi results share one budget with no partial success', async () => {
    const multi = { queryType: 'regularQuery', results: [root(), root()], slowQuery: false };
    const control = parse(await getFinalQueryResultMulti([transform(), transform()], [raw(), raw()], multi));
    expect(parse(await getFinalQueryResultMulti([transform(), transform()], [raw(), raw()], multi, 12))).toEqual(control);
    await expect(getFinalQueryResultMulti([transform(), transform()], [raw(), raw()], multi, 11)).rejects.toMatchObject(exceeded);
    expect(parse(await getFinalQueryResultMulti([transform(), transform()], [raw(), raw()], multi))).toEqual(control);
  });
  test('vanilla time aliases count generated base fields', async () => {
    const t = {
      aliasToMemberNameMap: { month: 'Neutral.date.month' },
      annotation: { 'Neutral.date.month': { type: 'time' } },
      query: { timeDimensions: [{ dimension: 'Neutral.date', granularity: 'month' }] },
      queryType: 'regularQuery',
    };
    const data = rowsToColumnarBuffer([{ month: '2026-01-01T00:00:00.000' }]);
    const result = parse(await getFinalQueryResult(t, data, { ...root(), query: t.query }));
    expect(Object.keys(result.data[0])).toEqual(expect.arrayContaining(['Neutral.date.month', 'Neutral.date']));
    await expect(getFinalQueryResult(t, data, { ...root(), query: t.query }, 1)).rejects.toMatchObject(exceeded);
    expect(parse(await getFinalQueryResult(t, data, { ...root(), query: t.query }, 2))).toEqual(result);
  });
  test('multiple time granularities count their final fields once', async () => {
    const q = { timeDimensions: [
      { dimension: 'Neutral.date', granularity: 'year' },
      { dimension: 'Neutral.date', granularity: 'month' },
    ] };
    const t = {
      aliasToMemberNameMap: { year: 'Neutral.date.year', month: 'Neutral.date.month' },
      annotation: { 'Neutral.date.year': { type: 'time' }, 'Neutral.date.month': { type: 'time' } },
      query: q,
      queryType: 'regularQuery',
    };
    const data = rowsToColumnarBuffer([{ year: '2026-01-01T00:00:00.000', month: '2026-02-01T00:00:00.000' }]);
    const result = parse(await getFinalQueryResult(t, data, { ...root(), query: q }));
    expect(Object.keys(result.data[0]).sort()).toEqual(['Neutral.date', 'Neutral.date.month', 'Neutral.date.year']);
    await expect(getFinalQueryResult(t, data, { ...root(), query: q }, 2)).rejects.toMatchObject(exceeded);
    expect(parse(await getFinalQueryResult(t, data, { ...root(), query: q }, 3))).toEqual(result);
  });
  test('compare date range counts its generated data column', async () => {
    const q = { ...query, timeDimensions: [{ dimension: 'Neutral.date', dateRange: ['2026-01-01', '2026-01-31'] }] };
    const t = { ...transform(), query: q, queryType: 'compareDateRangeQuery' };
    const result = parse(await getFinalQueryResult(t, raw(), { ...root(), query: q }));
    expect(Object.keys(result.data[0])).toContain('compareDateRange');
    await expect(getFinalQueryResult(t, raw(), { ...root(), query: q }, 8)).rejects.toMatchObject(exceeded);
    expect(parse(await getFinalQueryResult(t, raw(), { ...root(), query: q }, 9))).toEqual(result);
  });
  test('duplicate source aliases count only keys actually emitted', async () => {
    const t = { ...transform(), aliasToMemberNameMap: { a: 'Neutral.value', b: 'Neutral.value' } };
    const data = rowsToColumnarBuffer([{ a: 1, b: 2 }]);
    const result = parse(await getFinalQueryResult(t, data, root(), 1));
    expect(Object.keys(result.data[0])).toEqual(['Neutral.value']);
  });
  test('wrapper applies env policy without materializing native data in JS', async () => {
    process.env.CUBEJS_DB_QUERY_DATA_POINT_LIMIT = '5';
    const result = wrapper();
    await expect(result.getFinalResult()).rejects.toMatchObject(exceeded);
    expect(result.cached).toBe(false);
    delete process.env.CUBEJS_DB_QUERY_DATA_POINT_LIMIT;
    const control = parse(await result.getFinalResult());
    expect(control.data).toHaveLength(3);
    expect(result.cached).toBe(false);
  });
  test('multi wrapper uses one load budget; SQL transport wrapper stays uncapped', async () => {
    process.env.CUBEJS_DB_QUERY_DATA_POINT_LIMIT = '11';
    const results = [wrapper(), wrapper()];
    await expect(new ResultMultiWrapper(results, { queryType: 'regularQuery', slowQuery: false }).getFinalResult()).rejects.toMatchObject(exceeded);
    process.env.CUBEJS_DB_QUERY_DATA_POINT_LIMIT = '1';
    expect(await new ResultArrayWrapper(results).getFinalResult()).toHaveLength(3);
  });
  test.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])('native boundary rejects invalid cap %s', async (limit) => {
    expect(() => getFinalQueryResult(transform(), raw(), root(), limit)).toThrow('positive safe integer');
  });
  test('maximum safe integer does not overflow', async () => {
    expect(parse(await getFinalQueryResult(transform(), raw(), root(), Number.MAX_SAFE_INTEGER)).data).toHaveLength(3);
  });
});
