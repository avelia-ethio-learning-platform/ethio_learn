import { CommunityController } from './community.controller';

/** P2-43: the bare-array form Phase 9e kept for older clients is gone; every read is the paged shape. */
describe('CommunityController comments shape', () => {
  const page = { items: [{ id: 'c1' }], has_more: true };
  const service = { listComments: jest.fn(async () => page) };
  const controller = new CommunityController(service as never);

  it('answers { items, has_more } without paged or before', async () => {
    expect(await controller.list('course', {})).toEqual(page);
  });

  it('answers { items, has_more } with paged=1 or a before cursor', async () => {
    expect(await controller.list('course', { paged: '1' })).toEqual(page);
    expect(await controller.list('course', { before: 'c9' })).toEqual(page);
    expect(service.listComments).toHaveBeenLastCalledWith('course', 'c9');
  });
});
