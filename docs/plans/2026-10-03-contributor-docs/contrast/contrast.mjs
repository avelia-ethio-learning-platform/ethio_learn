const hex = (h) => { h = h.replace('#',''); return [0,2,4].map(i => parseInt(h.slice(i,i+2),16)); };
const rgb = (s) => s.startsWith('#') ? hex(s) : s.split(/[ ,]+/).map(Number);
const over = (fg, a, bg) => fg.map((c,i) => Math.round(c*a + bg[i]*(1-a)));
const lum = ([r,g,b]) => { const f = c => { c/=255; return c<=0.03928? c/12.92 : ((c+0.055)/1.055)**2.4; }; return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b); };
const cr = (a,b) => { const [x,y] = [lum(a),lum(b)].sort((p,q)=>q-p); return ((x+0.05)/(y+0.05)); };
const L = { bg:'#ffffff', bg2:'#fafbff', bg3:'#f1f5ff', fg:'#0f172a', muted:'#64748b', g500:'#64748b', g600:'#475569', g700:'#334155', b500:'#3b82f6', b600:'#2563eb', b700:'#1d4ed8' };
const D = { bg:'#0f172a', bg2:'#1e293b', bg3:'#334155', fg:'#f8fafc', muted:'#94a3b8', g500:'rgb 148 163 184', g600:'178 191 210', g700:'203 213 225', b500:'96 165 250', b600:'96 165 250', b700:'147 197 253' };
for (const k of Object.keys(D)) if (!D[k].startsWith('#')) D[k] = D[k].replace('rgb ','');
const cardD = over(rgb('30 41 59'), 0.72, rgb(D.bg));
const rows = [];
const t = (theme, label, fg, bg, need=4.5) => { const r = cr(rgb(typeof fg==='string'?fg:fg.join(' ')), Array.isArray(bg)?bg:rgb(bg)); rows.push([theme, label, r.toFixed(2), r>=need?'pass':'FAIL '+need]); };
// light
for (const [n,b] of [['background',L.bg],['bg-secondary',L.bg2],['bg-tertiary',L.bg3]]) {
  t('light',`foreground on ${n}`,L.fg,b); t('light',`muted-foreground on ${n}`,L.muted,b); t('light',`gray-600 on ${n}`,L.g600,b);
  t('light',`brand-600 text on ${n}`,L.b600,b); t('light',`brand-700 text on ${n}`,L.b700,b);
}
t('light','white on .btn start #1d4ed8','#ffffff',L.b700); t('light','white on .btn end #2563eb','#ffffff',L.b600);
t('light','white on .btn-danger #b91c1c','#ffffff','#b91c1c');
t('light','badge-success #047857 on emerald/12','#047857',over(rgb('#10b981'),.12,rgb(L.bg)));
t('light','badge-warn #b45309 on amber/12','#b45309',over(rgb('#f59e0b'),.12,rgb(L.bg)));
t('light','badge-danger #b91c1c on red/10','#b91c1c',over(rgb('#ef4444'),.10,rgb(L.bg)));
t('light','badge-info brand-700 on blue/10',L.b700,over(rgb('#3b82f6'),.10,rgb(L.bg)));
t('light','badge-neutral gray-600 on gray-100',L.g600,'#f1f5f9');
t('light','text-red-600 on white','#dc2626',L.bg); t('light','text-amber-700 on white','#b45309',L.bg); t('light','text-emerald-700 on white','#047857',L.bg);
t('light','text-amber-600 on white','#d97706',L.bg); t('light','text-emerald-600 on white','#059669',L.bg); t('light','text-green-700 on white','#15803d',L.bg);
t('light','focus ring brand-600 vs white (3:1)',L.b600,L.bg,3);
t('light','bar brand-500/80 vs white (3:1)',over(rgb(L.b500),.8,rgb(L.bg)).join(' '),L.bg,3);
t('light','input border blue/14 vs white (3:1, informative)',over(rgb('#3b82f6'),.14,rgb(L.bg)).join(' '),L.bg,3);
for (const [n,c] of [['tech','#1d4ed8'],['business','#b45309'],['freelancing','#6d28d9'],['healthcare','#047857'],['other','#475569']]) t('both',`white on cover ${n} ${c}`,'#ffffff',c);
t('both','flag yellow #fcdd09 vs white (decorative)','#fcdd09','#ffffff',3);
// dark
for (const [n,b] of [['background',rgb(D.bg)],['bg-secondary',rgb(D.bg2)],['bg-tertiary',rgb(D.bg3)],['card over bg',cardD]]) {
  t('dark',`foreground on ${n}`,D.fg,b); t('dark',`muted-foreground on ${n}`,D.muted,b); t('dark',`gray-500 on ${n}`,D.g500,b); t('dark',`gray-600 on ${n}`,D.g600,b);
  t('dark',`brand-600 text on ${n}`,D.b600,b); t('dark',`brand-700 text on ${n}`,D.b700,b);
}
t('dark','badge-success #34d399 on emerald/12','#34d399',over(rgb('#10b981'),.12,rgb(D.bg)));
t('dark','badge-warn #fbbf24 on amber/12','#fbbf24',over(rgb('#f59e0b'),.12,rgb(D.bg)));
t('dark','badge-danger #f87171 on red/10','#f87171',over(rgb('#ef4444'),.10,rgb(D.bg)));
t('dark','badge-info brand-700 on blue/10',D.b700,over(rgb('#3b82f6'),.10,rgb(D.bg)));
t('dark','badge-neutral gray-600 on gray-100',D.g600,'30 41 59');
t('dark','text-red-400 on bg','#f87171',rgb(D.bg)); t('dark','text-amber-400 on bg','#fbbf24',rgb(D.bg)); t('dark','text-emerald-400 on bg','#34d399',rgb(D.bg));
t('dark','text-red-600 on bg (light class left in dark)','#dc2626',rgb(D.bg)); t('dark','text-amber-700 on bg (light class left in dark)','#b45309',rgb(D.bg)); t('dark','text-emerald-700 on bg (light class in dark)','#047857',rgb(D.bg));
t('dark','focus ring #60a5fa vs bg (3:1)',D.b600,rgb(D.bg),3);
t('dark','bar brand-500/80 vs bg (3:1)',over(rgb(D.b500),.8,rgb(D.bg)).join(' '),rgb(D.bg),3);
t('dark','white on .btn #2563eb','#ffffff','#2563eb');
for (const r of rows) console.log(r.join(' | '));
