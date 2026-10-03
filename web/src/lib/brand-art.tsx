/**
 * Shared artwork for the generated icons and the OG image: the header logo
 * (white mortarboard cap on brand blue, with the flag hairline along the
 * bottom edge). Rendered by next/og's ImageResponse, so it only uses inline
 * styles and flexbox.
 */
export const BRAND_BLUE = '#2563eb';

const FLAG = 'linear-gradient(90deg, #078930 0%, #fcdd09 50%, #da121a 100%)';

/** The cap mark, drawn in a 24x24 box (same glyph as the header's GraduationCap). */
function Cap({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z" />
      <path d="M22 10v6" />
      <path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5" />
    </svg>
  );
}

/**
 * Square icon. `artScale` is the share of the canvas the cap occupies; the
 * maskable variant uses a small scale so the artwork stays inside the inner
 * 80% safe zone and fills the whole square background (no rounded corners).
 */
export function IconArt({ size, artScale = 0.62, rounded = true }: { size: number; artScale?: number; rounded?: boolean }) {
  const art = Math.round(size * artScale);
  const hairline = Math.max(2, Math.round(size * 0.03));
  return (
    <div
      style={{
        width: size,
        height: size,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        background: BRAND_BLUE,
        borderRadius: rounded ? Math.round(size * 0.22) : 0,
        overflow: 'hidden',
      }}
    >
      <Cap size={art} />
      {rounded && <div style={{ position: 'absolute', left: 0, bottom: 0, width: size, height: hairline, background: FLAG }} />}
    </div>
  );
}

/** 1200x630 site card: blue panel, cap mark, wordmark and the flag band. */
export function OgArt() {
  return (
    <div
      style={{
        width: 1200,
        height: 630,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        position: 'relative',
        padding: '0 96px',
        background: `linear-gradient(135deg, ${BRAND_BLUE} 0%, #1d4ed8 100%)`,
        color: '#ffffff',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <div
          style={{
            width: 140,
            height: 140,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 32,
            background: 'rgba(255,255,255,0.16)',
          }}
        >
          <Cap size={92} />
        </div>
        <div style={{ display: 'flex', marginLeft: 36, fontSize: 96, fontWeight: 800, letterSpacing: -2 }}>EthiopiaLearn</div>
      </div>
      <div style={{ display: 'flex', marginTop: 40, fontSize: 44, lineHeight: 1.25, maxWidth: 900, color: '#dbeafe' }}>
        Learn skills from Ethiopian experts
      </div>
      <div style={{ position: 'absolute', left: 0, bottom: 0, width: 1200, height: 24, background: FLAG }} />
    </div>
  );
}
