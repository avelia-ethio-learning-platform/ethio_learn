import { CommunityController } from './community.controller';

/** Phase 9e: comments keep a bare array for clients that don't ask for the paged shape. */
describe('CommunityController comments shape', () => {
  const page = { items: [{ id: 'c1' }], has_more: true };
  const service = { listComments: jest.fn(async () => page) };
  const controller = new CommunityController(service as never);

  it('answers the bare array without paged or before', async () => {
    expect(await controller.list('course', {})).toEqual([{ id: 'c1' }]);
  });

  it('answers { items, has_more } with paged=1 or a before cursor', async () => {
    expect(await controller.list('course', { paged: '1' })).toEqual(page);
    expect(await controller.list('course', { before: 'c9' })).toEqual(page);
    expect(service.listComments).toHaveBeenLastCalledWith('course', 'c9');
  });
});
