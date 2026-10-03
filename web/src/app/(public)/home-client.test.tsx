import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { HomeClient } from './home-client';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

function serverHome() {
  const doc = document.implementation.createHTMLDocument('home');
  doc.body.innerHTML = renderToString(<HomeClient courses={[]} total={0} />);
  return doc;
}

describe('home hero', () => {
  it('shows no rating stars', () => {
    expect(serverHome().querySelector('svg.lucide-star')).toBeNull();
  });

  it('server HTML hides none of the heading, copy, search or CTAs', () => {
    const doc = serverHome();
    const hero = doc.querySelector('section')!;
    for (const el of [hero.querySelector('h1')!, hero.querySelector('h1 + p')!, hero.querySelector('form')!, ...Array.from(hero.querySelectorAll('a[href="/courses"], a[href^="/signup"]'))]) {
      expect(el.closest('[style*="opacity:0"]'), el.outerHTML.slice(0, 60)).toBeNull();
    }
  });

  it('has exactly one CSS entrance, on the hero panel', () => {
    const hero = serverHome().querySelector('section')!;
    expect(hero.querySelectorAll('.animate-in')).toHaveLength(1);
  });

  it('names the hero search input for screen readers', () => {
    const input = serverHome().querySelector('section form input[name="q"]')!;
    expect(input.getAttribute('aria-label')).toBeTruthy();
  });
});
