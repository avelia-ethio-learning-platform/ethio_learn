import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PasswordStrength, scorePassword } from './PasswordStrength';

describe('scorePassword', () => {
  it('scores by the four rules', () => {
    expect(scorePassword('abc').score).toBe(0); // too short, one case, no digit/symbol
    expect(scorePassword('Password').score).toBe(2);
    expect(scorePassword('Password1').score).toBe(3);
    expect(scorePassword('Password1!').score).toBe(4);
  });

  it('labels the extremes correctly', () => {
    expect(scorePassword('').label).toBe('Very weak');
    expect(scorePassword('Password1!').label).toBe('Strong');
  });
});

describe('<PasswordStrength />', () => {
  it('renders nothing until the user types', () => {
    const { container } = render(<PasswordStrength value="" />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the label and the unmet rules', () => {
    render(<PasswordStrength value="Password" />);
    expect(screen.getByText('Fair')).toBeTruthy();
    expect(screen.getByText(/A number/).className).toContain('text-gray-400'); // unmet
    expect(screen.getByText(/At least 8 characters/).className).toContain('text-green-600'); // met
  });
});
