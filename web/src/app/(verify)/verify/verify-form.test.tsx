import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

import { VerifyForm } from './verify-form';

beforeEach(() => push.mockReset());
afterEach(cleanup);

function submit(value: string) {
  render(<VerifyForm />);
  fireEvent.change(screen.getByLabelText('Certificate ID'), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
}

describe('/verify form', () => {
  it('routes a trimmed certificate ID to its verification page', () => {
    submit('  CERT-2026-ab12  ');
    expect(push).toHaveBeenCalledWith('/verify/CERT-2026-ab12');
  });

  it('encodes characters that would change the path', () => {
    submit('a/b?c');
    expect(push).toHaveBeenCalledWith('/verify/a%2Fb%3Fc');
  });

  it('does nothing for blank input', () => {
    submit('   ');
    expect(push).not.toHaveBeenCalled();
  });
});
