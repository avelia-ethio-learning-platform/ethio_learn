import { BadRequestException, Controller, Get, ParseUUIDPipe, PipeTransform } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import {
  CertificateUidPipe,
  InviteTokenPipe,
  PayRequestTokenPipe,
  UuidParam,
} from './params';

const meta = { type: 'param' as const };
const NIL = '00000000-0000-0000-0000-000000000000';
const V4 = '3f2b8c1e-5d4a-4b7e-9c1d-2a6f8e0b1c3d';

function expectRejects(pipe: PipeTransform, value: string) {
  expect(() => pipe.transform(value, meta)).toThrow(BadRequestException);
}

describe('UuidParam', () => {
  @Controller()
  class Probe {
    @Get(':id')
    one(@UuidParam('id') _id: string) {}
  }

  const pipe = (() => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, Probe, 'one');
    const key = Object.keys(args)[0];
    expect(args[key].data).toBe('id');
    expect(args[key].pipes).toHaveLength(1);
    return args[key].pipes[0] as ParseUUIDPipe;
  })();

  it('attaches a ParseUUIDPipe to the named param', () => {
    expect(pipe).toBeInstanceOf(ParseUUIDPipe);
  });

  it.each(['not-a-uuid', '../users/' + V4, ''])('rejects %p', async (value) => {
    await expect(pipe.transform(value, meta)).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([V4, NIL])('accepts %s (any version, nil included)', async (value) => {
    await expect(pipe.transform(value, meta)).resolves.toBe(value);
  });
});

describe('InviteTokenPipe', () => {
  const pipe = new InviteTokenPipe();
  const token = 'a1b2c3d4'.repeat(8);

  it('accepts 64 lowercase hex chars', () => {
    expect(pipe.transform(token, meta)).toBe(token);
  });

  it.each(['g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'A1B2C3D4'.repeat(8), '../x', ''])('rejects %p', (value) => {
    expectRejects(pipe, value);
  });
});

describe('PayRequestTokenPipe', () => {
  const pipe = new PayRequestTokenPipe();
  const token = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // 24 chars from the code alphabet

  it('accepts 24 chars from the code alphabet', () => {
    expect(pipe.transform(token, meta)).toBe(token);
  });

  it.each(['A'.repeat(23), 'A'.repeat(25), 'O'.repeat(24), '0'.repeat(24), 'a'.repeat(24), '../x', ''])('rejects %p', (value) => {
    expectRejects(pipe, value);
  });
});

describe('CertificateUidPipe', () => {
  const pipe = new CertificateUidPipe();

  it('accepts a uuid-shaped value and keeps its case', () => {
    expect(pipe.transform(V4, meta)).toBe(V4);
    const mixed = '3F2b8C1e-5d4A-4b7e-9C1d-2a6F8e0B1c3D';
    expect(pipe.transform(mixed, meta)).toBe(mixed);
  });

  it.each(['not-a-uuid', V4 + '0', V4.slice(0, -1), V4.replace(/-/g, ''), 'g' + V4.slice(1), '../x', ''])('rejects %p', (value) => {
    expectRejects(pipe, value);
  });
});
