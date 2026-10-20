import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { testLogger } from '@cubejs-backend/shared';
import { ApiGateway } from '../src';
import { compilerApi, AdapterApiMock, DataSourceStorageMock } from './mocks';

class RowsAdapter extends AdapterApiMock {
  public calls: any[] = [];

  public constructor(private rows = [{ foo__bar: 1 }, { foo__bar: 0 }, { foo__bar: null }]) { super(); }

  public async executeQuery(query: any): Promise<any> {
    this.calls.push(query);
    return { data: this.rows, lastRefreshTime: new Date('2026-01-01T00:00:00Z') };
  }
}
function gateway(adapter = new RowsAdapter()) {
  let graphqlSchema: any;
  const compiler = async () => ({
    ...(await compilerApi()),
    getGraphQLSchema: () => graphqlSchema,
    setGraphQLSchema: (schema: any) => { graphqlSchema = schema; },
  });
  const api = new ApiGateway('synthetic-secret', compiler, async () => adapter, testLogger, {
    standalone: true,
    devServer: false,
    dataSourceStorage: new DataSourceStorageMock(),
    basePath: '/cubejs-api',
    refreshScheduler: {},
  });
  const app = express(); app.use(express.json()); api.initApp(app);
  return { app, api, adapter };
}
const token = jwt.sign({}, 'synthetic-secret');
const query = { measures: ['Foo.bar'] };
const load = (app: any, q: any = query) => request(app).post('/cubejs-api/v1/load')
  .set('Authorization', token).send({ query: q });

describe('buffered REST and GraphQL output budget', () => {
  const original = process.env.CUBEJS_DB_QUERY_DATA_POINT_LIMIT;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.CUBEJS_DB_QUERY_DATA_POINT_LIMIT;
    } else {
      process.env.CUBEJS_DB_QUERY_DATA_POINT_LIMIT = original;
    }
  });
  test('REST exact limit succeeds; overflow is 400 UserError with no partial data', async () => {
    process.env.CUBEJS_DB_QUERY_DATA_POINT_LIMIT = '3';
    const { app, adapter } = gateway();
    const good = await load(app).expect(200);
    expect(good.body.data).toEqual([{ 'Foo.bar': '1' }, { 'Foo.bar': '0' }, { 'Foo.bar': null }]);
    const sql = adapter.calls[0].query;
    process.env.CUBEJS_DB_QUERY_DATA_POINT_LIMIT = '2';
    const bad = await load(app).expect(400);
    expect(bad.body.type).toBe('UserError');
    expect(bad.body.error).toBe('The query data point limit has been exceeded.');
    expect(bad.body.data).toBeUndefined();
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1].query).toBe(sql);
  });
  test('disabled behavior and empty results remain unchanged', async () => {
    delete process.env.CUBEJS_DB_QUERY_DATA_POINT_LIMIT;
    const { app } = gateway();
    const control = (await load(app).expect(200)).body;
    process.env.CUBEJS_DB_QUERY_DATA_POINT_LIMIT = '3';
    expect((await load(app).expect(200)).body).toEqual(control);
    process.env.CUBEJS_DB_QUERY_DATA_POINT_LIMIT = '1';
    expect((await load(gateway(new RowsAdapter([])).app).expect(200)).body.data).toEqual([]);
  });
  test('REST multi-load sums results instead of budgeting every leg separately', async () => {
    const multiQuery = { ...query, timeDimensions: [{ dimension: 'Foo.time', compareDateRange: [['2026-01-01', '2026-01-03'], ['2026-01-01', '2026-01-03']] }] };
    process.env.CUBEJS_DB_QUERY_DATA_POINT_LIMIT = '6';
    const { app } = gateway();
    const response = await request(app).post('/cubejs-api/v1/load').set('Authorization', token)
      .send({ query: multiQuery, queryType: 'multi' })
      .expect(400);
    expect(response.body.type).toBe('UserError');
    expect(response.body.results).toBeUndefined();
    process.env.CUBEJS_DB_QUERY_DATA_POINT_LIMIT = '12';
    const good = await request(app).post('/cubejs-api/v1/load').set('Authorization', token)
      .send({ query: multiQuery, queryType: 'multi' })
      .expect(200);
    expect(good.body.results).toHaveLength(2);
  });
  test('GraphQL propagates the same guard without a successful partial dataset', async () => {
    process.env.CUBEJS_DB_QUERY_DATA_POINT_LIMIT = '2';
    const { app, adapter } = gateway();
    const response = await request(app).post('/cubejs-api/graphql').set('Authorization', token)
      .send({ query: '{ cube { foo { bar } } }' });
    expect(response.body.errors[0].message).toContain('data point limit');
    expect(response.body.data?.cube ?? null).toBeNull();
    expect(adapter.calls).toHaveLength(1);
    process.env.CUBEJS_DB_QUERY_DATA_POINT_LIMIT = '3';
    const good = await request(app).post('/cubejs-api/graphql').set('Authorization', token)
      .send({ query: '{ cube { foo { bar } } }' });
    expect(good.body.errors).toBeUndefined();
    expect(good.body.data.cube).toHaveLength(3);
  });
  test('GraphQL sibling resolvers have independent load budgets', async () => {
    process.env.CUBEJS_DB_QUERY_DATA_POINT_LIMIT = '3';
    const { app, adapter } = gateway();
    const response = await request(app).post('/cubejs-api/graphql').set('Authorization', token)
      .send({ query: '{ first: cube { foo { bar } } second: cube { foo { bar } } }' });
    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.first).toHaveLength(3);
    expect(response.body.data.second).toHaveLength(3);
    expect(adapter.calls).toHaveLength(2);
  });
  test('SQL transport remains excluded even when output exceeds the cap', async () => {
    process.env.CUBEJS_DB_QUERY_DATA_POINT_LIMIT = '1';
    const { api } = gateway();
    let response: any;
    await api.sqlApiLoad({
      query,
      streaming: false,
      memberExpressions: true,
      context: { requestId: 'synthetic-sql', securityContext: {} },
      res: (r: any) => { response = r; },
      apiType: 'sql',
    } as any);
    expect(response.error).toBeUndefined();
    expect(response.getResults()).toHaveLength(1);
  });
  test('invalid configuration fails before adapter execution', () => {
    process.env.CUBEJS_DB_QUERY_DATA_POINT_LIMIT = '0';
    expect(() => gateway()).toThrow('CUBEJS_DB_QUERY_DATA_POINT_LIMIT');
  });
});
