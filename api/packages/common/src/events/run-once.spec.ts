import { DataSource } from 'typeorm';
import { runOnce } from './run-once';

/** processed_events in memory, with a transaction that rolls back on throw. Speaks the three statements runOnce sends. */
function fakeDataSource() {
  let rows = new Map<string, { result: unknown }>();
  const key = (params: unknown[]) => `${params[0]}|${params[1]}`;
  const manager = {
    getRepository: () => ({ metadata: { tablePath: 'quality.processed_events' } }),
    query: jest.fn(async (sql: string, params: unknown[]) => {
      if (sql.startsWith('INSERT')) {
        if (rows.has(key(params))) return [];
        rows.set(key(params), { result: null });
        return [{ '?column?': 1 }];
      }
      if (sql.startsWith('SELECT')) return rows.has(key(params)) ? [rows.get(key(params))] : [];
      if (sql.startsWith('UPDATE')) rows.get(key(params))!.result = JSON.parse(params[2] as string);
      return [];
    }),
  };
  const dataSource = {
    transaction: async <T>(fn: (m: typeof manager) => Promise<T>): Promise<T> => {
      const before = new Map(rows);
      try {
        return await fn(manager);
      } catch (err) {
        rows = before;
        throw err;
      }
    },
  } as unknown as DataSource;
  return { dataSource, manager, rows: () => rows };
}

describe('runOnce', () => {
  it('runs the effect once per (consumer, event), and hands the stored result to a redelivery', async () => {
    const { dataSource } = fakeDataSource();
    const effect = jest.fn(async () => ({ item_id: 'item-1' }));

    await expect(runOnce(dataSource, 'quality:submission', 'evt-1', effect)).resolves.toEqual({ ran: true, result: { item_id: 'item-1' } });
    await expect(runOnce(dataSource, 'quality:submission', 'evt-1', effect)).resolves.toEqual({ ran: false, result: { item_id: 'item-1' } });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('keys on the consumer too: another handler of the same event runs', async () => {
    const { dataSource } = fakeDataSource();
    const effect = jest.fn(async () => undefined);
    await runOnce(dataSource, 'quality:stats', 'evt-1', effect);
    await expect(runOnce(dataSource, 'course:enrolled-count', 'evt-1', effect)).resolves.toEqual({ ran: true, result: null });
    expect(effect).toHaveBeenCalledTimes(2);
  });

  it('a failed effect leaves no marker, so the retry runs it', async () => {
    const { dataSource } = fakeDataSource();
    const effect = jest.fn().mockRejectedValueOnce(new Error('connection reset')).mockResolvedValueOnce({ item_id: 'item-2' });

    await expect(runOnce(dataSource, 'quality:submission', 'evt-1', effect)).rejects.toThrow('connection reset');
    await expect(runOnce(dataSource, 'quality:submission', 'evt-1', effect)).resolves.toEqual({ ran: true, result: { item_id: 'item-2' } });
  });

  it('refuses a handler without an explicit name, or an event without an id', async () => {
    const { dataSource } = fakeDataSource();
    await expect(runOnce(dataSource, '', 'evt-1', async () => undefined)).rejects.toThrow(/explicit name/);
    await expect(runOnce(dataSource, 'quality:stats', '', async () => undefined)).rejects.toThrow(/event id/);
  });

  it('writes to the service schema’s table', async () => {
    const { dataSource, manager } = fakeDataSource();
    await runOnce(dataSource, 'quality:stats', 'evt-1', async () => undefined);
    expect(manager.query.mock.calls[0][0]).toContain('INSERT INTO quality.processed_events');
  });
});
