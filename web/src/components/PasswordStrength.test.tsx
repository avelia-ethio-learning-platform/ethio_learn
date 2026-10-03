import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PasswordStrength, scorePassword } from './PasswordStrength';

// Copy of the server rule in api/services/auth/src/dto.ts (IsStrongPassword). Web cannot import api code,
// so this copy is the drift pin: change one and this table fails until the other follows.
function serverAccepts(value: string): boolean {
  if (value.length < 8 || value.length > 128) return false;
  return [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length >= 3;
}

const TABLE = [
  '',
  'abc',
  'password',
  'PASSWORD',
  '12345678',
  '12345678!', // two categories: the old client let this through
  'Password', // two categories
  'password1',
  'Passw1!', // seven characters
  'Pass1!!', // seven characters
  'Password1',
  'password1!',
  'PASSWORD1!',
  'Password!',
  'Password1!',
  'Ünïcödé123!', // non-ASCII letters count as symbols on both sides
  'a1!'.repeat(42), // 126 characters
  'Aa1'.repeat(43), // 129 characters
  'Aa1'.repeat(42) + 'Aa', // 128 characters
];

describe('scorePassword', () => {
  it('agrees with the server rule on every row of the table', () => {
    for (const pw of TABLE) expect({ pw, ok: scorePassword(pw).ok }).toEqual({ pw, ok: serverAccepts(pw) });
  });

  it('is not ok for the case the old rule let through', () => {
    expect(scorePassword('12345678!').ok).toBe(false);
    expect(scorePassword('Password1').ok).toBe(true);
  });

  it('labels weak, good and strong', () => {
    expect(scorePassword('').label).toBe('Very weak');
    expect(scorePassword('Password').label).toBe('Weak');
    expect(scorePassword('Password1').label).toBe('Good');
    expect(scorePassword('Password1!').label).toBe('Strong');
  });
});

describe('<PasswordStrength />', () => {
  it('renders nothing until the user types', () => {
    const { container } = render(<PasswordStrength value="" />);
    expect(container.firstChild).toBeNull();
  });

  it('ticks the length and each met category, and says 3 of these 4', () => {
    render(<PasswordStrength value="Password" />);
    expect(screen.getByText(/At least 8 characters/).className).toContain('text-green-700');
    expect(screen.getByText(/3 of these 4/).className).toContain('text-gray-500'); // two categories only
    expect(screen.getByText('lowercase').className).toContain('text-green-700');
    expect(screen.getByText('uppercase').className).toContain('text-green-700');
    expect(screen.getByText('number').className).toContain('text-gray-500');
    expect(screen.getByText('symbol').className).toContain('text-gray-500');
  });
});
