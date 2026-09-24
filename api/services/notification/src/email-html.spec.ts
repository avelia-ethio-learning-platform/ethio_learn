import { escapeHtml, html, SafeHtml } from './email-html';

describe('email html helpers', () => {
  it('escapes markup in user text', () => {
    expect(escapeHtml(`<b>"Tom" & 'Jerry'</b>`)).toBe('&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;');
  });

  it('escapes every interpolated value but keeps the template markup', () => {
    const name = '<img src=x onerror=alert(1)>';
    expect(html`<p>Hi ${name}, you owe ${400} ETB</p>`.value).toBe('<p>Hi &lt;img src=x onerror=alert(1)&gt;, you owe 400 ETB</p>');
  });

  it('nests html fragments without escaping them twice', () => {
    const title = 'Tom & Jerry';
    const inner = html`<strong>${title}</strong>`;
    expect(inner).toBeInstanceOf(SafeHtml);
    expect(html`<p>${inner}</p>`.value).toBe('<p><strong>Tom &amp; Jerry</strong></p>');
  });

  it('renders null, undefined and false as nothing, and arrays item by item', () => {
    const none: string | null = null;
    expect(html`a${none}b${undefined}c${false}d`.value).toBe('abcd');
    expect(html`<ul>${['<x>', html`<li>ok</li>`]}</ul>`.value).toBe('<ul>&lt;x&gt;<li>ok</li></ul>');
  });

  it('escapes a quote so a value cannot break out of an attribute', () => {
    const href = 'https://x.et/" onclick="steal()';
    expect(html`<a href="${href}">go</a>`.value).toBe('<a href="https://x.et/&quot; onclick=&quot;steal()">go</a>');
  });
});
