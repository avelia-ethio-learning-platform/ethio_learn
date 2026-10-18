// Target palette for docs/COLOR_SYSTEM.md (Phase 11d spec, built in 7c). Prints the doc's contrast table.
// Each row is checked on the surfaces named in its "checked on" column; the ratio is the lowest of them.
const hex = (h) => { h = h.replace('#',''); return [0,2,4].map(i => parseInt(h.slice(i,i+2),16)); };
const over = (fg, a, bg) => fg.map((c,i) => Math.round(c*a + bg[i]*(1-a)));
const lum = ([r,g,b]) => { const f = c => { c/=255; return c<=0.03928? c/12.92 : ((c+0.055)/1.055)**2.4; }; return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b); };
const cr = (a,b) => { const [x,y] = [lum(a),lum(b)].sort((p,q)=>q-p); return (x+0.05)/(y+0.05); };
const T = {
  light: { bg:'#ffffff', bg2:'#fafbff', card:[[255,255,255],.92], g100:'#f1f5f9', g200:'#e2e8f0', b50:'#eff6ff', b100:'#dbeafe',
    fg:'#0f172a', muted:'#5b6b80', g600:'#475569', link:'#2563eb', brand700:'#1d4ed8', inputBorder:'#7c8ba1', ring:'#2563eb', fill:'#2563eb', rating:'#d97706',
    st: { success:['#047857',[16,185,129],.12,'#059669'], warning:['#b45309',[245,158,11],.12,'#d97706'], danger:['#b91c1c',[239,68,68],.10,'#dc2626'], info:['#1d4ed8',[59,130,246],.10,'#2563eb'] } },
  dark: { bg:'#0f172a', bg2:'#1e293b', card:[[30,41,59],.72], g100:'#1e293b', g200:'#2c3a52', b50:'#172554', b100:'#1e3a8a',
    fg:'#f8fafc', muted:'#9aa8bd', g600:'#b2bfd2', link:'#60a5fa', brand700:'#93c5fd', inputBorder:'#64748b', ring:'#60a5fa', fill:'#60a5fa', rating:'#fbbf24',
    st: { success:['#34d399',[16,185,129],.14,'#10b981'], warning:['#fbbf24',[245,158,11],.14,'#f59e0b'], danger:['#f87171',[239,68,68],.14,'#ef4444'], info:['#93c5fd',[59,130,246],.14,'#60a5fa'] } },
};
const out = [];
const fmt = (th, label, c, on, min, need) => out.push(`| ${th} | ${label} | \`${c}\` | ${on} | ${min.toFixed(2)} | ${need} | ${min>=need?'pass':'**FAIL**'} |`);
for (const [th, t] of Object.entries(T)) {
  const S = { page:hex(t.bg), secondary:hex(t.bg2), card:over(t.card[0], t.card[1], hex(t.bg)), 'gray-100':hex(t.g100), 'gray-200':hex(t.g200), 'brand-50':hex(t.b50), 'brand-100':hex(t.b100), track:over([59,130,246],.12,hex(t.bg)) };
  const row = (label, c, need, on) => fmt(th, label, c, on.join(', '), Math.min(...on.map(n => cr(hex(c), S[n]))), need);
  const base = ['page','secondary','card','gray-100'], all = [...base,'gray-200','brand-50','brand-100'];
  row('foreground', t.fg, 4.5, all);
  row('secondary text (`gray-600`)', t.g600, 4.5, all);
  row('muted text (`muted-foreground`, `gray-500`)', t.muted, 4.5, base);
  row('link / brand text (`brand-600`)', t.link, 4.5, ['page','secondary','card']);
  row('brand text on tints (`brand-700`)', t.brand700, 4.5, ['page','card','gray-100','brand-50','brand-100']);
  row('input border', t.inputBorder, 3, ['page','secondary','card']);
  row('focus ring', t.ring, 3, ['page','secondary','card']);
  row('chart bar', t.fill, 3, ['page','secondary','card']);
  row('progress fill', t.fill, 3, ['track','gray-200']);
  row('rating star fill', t.rating, 3, ['page','secondary','card']);
  for (const [name,[fg,tint,a,solid]] of Object.entries(t.st)) {
    const soft = over(tint, a, S.page);
    fmt(th, `${name} text`, fg, 'page, card, its soft tint', Math.min(cr(hex(fg),S.page), cr(hex(fg),S.card), cr(hex(fg),soft)), 4.5);
    row(`${name} solid`, solid, 3, ['page','secondary']);
  }
}
const W = hex('#ffffff');
for (const [n,c] of [['white on the primary button, darker end','#1d4ed8'],['white on the primary button, lighter end','#2563eb'],['white on the danger button','#b91c1c'],['white on cover: tech','#1d4ed8'],['white on cover: business','#b45309'],['white on cover: freelancing','#6d28d9'],['white on cover: healthcare','#047857'],['white on cover: other','#475569']]) fmt('both', n, c, 'its fill', cr(W, hex(c)), 4.5);
console.log(out.join('\n'));
