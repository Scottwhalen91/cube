import fs from 'fs';
import path from 'path';
import { PostgresQuery } from '../../src';
import { prepareYamlCompiler } from './PrepareCompiler';

const model = fs.readFileSync(path.resolve(process.cwd(), '../../examples/query-context/model.yml'), 'utf8');
const compilers = prepareYamlCompiler(model);
const sql = (options: any = {}) => new PostgresQuery(compilers, {
  measures: ['Ledger.amount'],
  dimensions: ['Ledger.root'],
  useNativeSqlPlanner: true,
  timezone: 'UTC',
  ...options,
}).buildSqlAndParams();

describe('Compile-time query context cases', () => {
  beforeAll(async () => { await compilers.compiler.compile(); });
  it.each(['Ledger.root', 'Ledger.section', 'Ledger.account'])(
    'compiles displayed grouping %s', dimension => {
      expect(sql({ dimensions: [dimension] })[0]).toContain('SELECT');
    }
  );
  it('preserves explicit nested depth filters', () => {
    const [, params] = sql({ filters: [{ and: [
      { member: 'Ledger.depth', operator: 'equals', values: ['0'] },
      { member: 'Ledger.account', operator: 'equals', values: ['A2'] },
    ] }] });
    expect(params).toContain('0');
    expect(params).toContain('A2');
  });
  it('supports aliased hierarchy members', () => {
    expect(sql({ measures: ['LedgerView.amount'], dimensions: ['LedgerView.item'] })[0]).toContain('SELECT');
  });
  it('inherits originating context through stage grain changes', () => {
    expect(sql({ measures: ['Ledger.grain_changed'] })[0]).toContain('SELECT');
  });
  it('keeps dimension-only lists independent of measure context', () => {
    expect(sql({ measures: [], dimensions: ['Ledger.account'] })[0]).toContain('SELECT');
  });
  it('preserves scalar blank and explicit override shapes', () => {
    expect(sql({ dimensions: [] })[0]).toContain('NULL');
    expect(sql({
      dimensions: [],
      filters: [
        { member: 'Ledger.depth', operator: 'equals', values: ['0'] },
      ]
    })[0]).toContain('SELECT');
  });
  it('discovers every possible dependency for authorization without evaluating context in JS', () => {
    const query = new PostgresQuery(compilers, {
      measures: ['Ledger.amount'], dimensions: ['Ledger.root'], useNativeSqlPlanner: true,
    });
    const members = query.collectAllMemberNames();

    for (const branch of ['Ledger.amount0', 'Ledger.amount1', 'Ledger.amount2', 'Ledger.raw_amount']) {
      expect(members).toContain(branch);
    }
  });
  it('rejects legacy context planning clearly', () => {
    expect(() => sql({ useNativeSqlPlanner: false })).toThrow(/Tesseract/);
  });
  it('keeps ordinary legacy measures usable', () => {
    expect(sql({ measures: ['Ledger.amount0'], useNativeSqlPlanner: false })[0]).toContain('SELECT');
  });
  it('rejects direct context-measure materialization', () => {
    expect(() => sql({ preAggregationQuery: true })).toThrow(/Materialize.*branch/);
  });
  it('keeps selection-sensitive query contexts independent', () => {
    for (const value of ['red', 'blue', 'red']) {
      expect(sql({
        measures: ['Ledger.amount', 'Ledger.comparison'],
        filters: [
          { member: 'Ledger.tenant', operator: 'equals', values: [value] },
        ]
      })[1]).toContain(value);
    }
  });
});

describe('Context schema validation', () => {
  it.each([
    '                grouped: Ledger.root\n                filtered: Ledger.depth',
    '                grouped: Ledger.root\n                equals: 0',
    '                deepest_grouped: [Ledger.root, Ledger.root]\n                equals: 0',
    '                single_value: Ledger.tenant',
    '                not: {}',
  ])('rejects malformed predicate %s', async predicate => {
    const source = model.replace('                filtered: Ledger.depth', predicate);
    await expect(prepareYamlCompiler(source).compiler.compile()).rejects.toThrow();
  });
  it('rejects unknown members in an unselected branch', async () => {
    const c = prepareYamlCompiler(model.replace('filtered: Ledger.depth', 'filtered: Ledger.missing'));
    await c.compiler.compile();
    expect(() => new PostgresQuery(c, {
      measures: ['Ledger.amount'], dimensions: ['Ledger.account'], useNativeSqlPlanner: true,
    }).buildSqlAndParams()).toThrow(/missing|resolve/i);
  });
  it.each([
    'grouped: Ledger.day.invalid_granularity',
    'deepest_grouped: [Ledger.account, LedgerView.item]\n                equals: 1',
  ])('rejects invalid resolved context reference %s', async predicate => {
    const c = prepareYamlCompiler(model.replace('filtered: Ledger.depth', predicate));
    await c.compiler.compile();
    expect(() => new PostgresQuery(c, {
      measures: ['Ledger.amount'], dimensions: ['Ledger.root'], useNativeSqlPlanner: true,
    }).buildSqlAndParams()).toThrow();
  });
});
