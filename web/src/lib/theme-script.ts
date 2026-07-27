/** Shared between the server layout (inline script) and the client ThemeProvider. */
export const THEME_STORAGE_KEY = 'el_theme';

/** Inline script source that applies `.dark` before first paint (no FOUC). */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');var d=t==='dark'||((!t||t==='system')&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(d)document.documentElement.classList.add('dark');}catch(e){}})();`;
