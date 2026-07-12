/**
 * Dependency-free client-side text extraction for the AI course generator.
 * The platform runs fully offline, so we cannot pull pdf.js/mammoth — instead
 * we use the browser's built-in DecompressionStream to inflate PDF/DOCX streams
 * and pull the text out. It is best-effort (typical text PDFs/Word exports work
 * well; scanned images or exotic encodings won't) and the result lands in an
 * editable box, so the educator can always review or paste text themselves.
 */

async function inflate(bytes: Uint8Array, format: 'deflate' | 'deflate-raw'): Promise<Uint8Array> {
  // Copy into a fresh ArrayBuffer-backed view so it's a valid BlobPart under
  // the stricter lib.dom typings (Uint8Array<ArrayBufferLike> is rejected).
  const part = new Uint8Array(bytes);
  const stream = new Blob([part]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function latin1(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    // .apply (not spread) so we don't require downlevelIteration on typed arrays.
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return s;
}

/** Decode a PDF literal string body: handle escapes and octal codes. */
function decodePdfString(body: string): string {
  return body.replace(/\\(n|r|t|b|f|\(|\)|\\|[0-7]{1,3})/g, (_m, esc) => {
    switch (esc) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'b': return '\b';
      case 'f': return '\f';
      case '(': return '(';
      case ')': return ')';
      case '\\': return '\\';
      default: return String.fromCharCode(parseInt(esc, 8));
    }
  });
}

/** Pull text out of a decoded PDF content stream (Tj / TJ operands). */
function textFromContentStream(content: string): string {
  const out: string[] = [];
  // Literal strings (…) — the operands of Tj/TJ. Balanced parens are rare in
  // real text, so a non-greedy scan with escape awareness is good enough.
  const re = /\((?:\\.|[^\\()])*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    out.push(decodePdfString(m[0].slice(1, -1)));
  }
  return out.join('');
}

async function extractPdf(data: Uint8Array): Promise<string> {
  const bin = latin1(data);
  const chunks: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bin))) {
    const start = m.index + m[0].length;
    const end = bin.indexOf('endstream', start);
    if (end < 0) continue;
    const header = bin.slice(Math.max(0, m.index - 400), m.index);
    const raw = data.subarray(start, end);
    let content: string;
    if (/\/FlateDecode/.test(header)) {
      try {
        content = latin1(await inflate(raw, 'deflate'));
      } catch {
        continue; // image / non-text stream
      }
    } else if (/\/(DCTDecode|CCITTFax|JPXDecode|Image)/.test(header)) {
      continue;
    } else {
      content = bin.slice(start, end);
    }
    if (/(Tj|TJ)\b/.test(content)) chunks.push(textFromContentStream(content));
  }
  return chunks.join('\n');
}

/** Minimal ZIP reader that inflates a single entry (word/document.xml). */
async function readZipEntry(data: Uint8Array, name: string): Promise<Uint8Array | null> {
  const bin = latin1(data);
  let pos = 0;
  while ((pos = bin.indexOf('PK\x03\x04', pos)) !== -1) {
    const view = new DataView(data.buffer, data.byteOffset + pos);
    const method = view.getUint16(8, true);
    const compSize = view.getUint32(18, true);
    const nameLen = view.getUint16(26, true);
    const extraLen = view.getUint16(28, true);
    const nameStart = pos + 30;
    const entryName = bin.slice(nameStart, nameStart + nameLen);
    const dataStart = nameStart + nameLen + extraLen;
    if (entryName === name) {
      const comp = data.subarray(dataStart, dataStart + compSize);
      return method === 0 ? comp : inflate(comp, 'deflate-raw');
    }
    pos = dataStart + compSize;
  }
  return null;
}

async function extractDocx(data: Uint8Array): Promise<string> {
  const xml = await readZipEntry(data, 'word/document.xml');
  if (!xml) return '';
  const text = new TextDecoder().decode(xml);
  return text
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export interface ExtractResult {
  text: string;
  warning?: string;
}

/** Extract plain text from an uploaded document, best-effort and offline. */
export async function extractTextFromFile(file: File): Promise<ExtractResult> {
  const name = file.name.toLowerCase();
  const clean = (s: string) => s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();

  if (/\.(txt|md|markdown|csv|tsv|html?|json|rtf)$/.test(name) || file.type.startsWith('text/')) {
    return { text: clean(await file.text()) };
  }
  const data = new Uint8Array(await file.arrayBuffer());
  if (name.endsWith('.pdf') || file.type === 'application/pdf') {
    const text = clean(await extractPdf(data));
    return text.length > 40
      ? { text }
      : { text, warning: 'Could not read much text from this PDF (it may be scanned images). Paste the text below instead.' };
  }
  if (name.endsWith('.docx')) {
    const text = clean(await extractDocx(data));
    return text.length > 20 ? { text } : { text, warning: 'Could not read this Word file. Paste the text below instead.' };
  }
  return { text: '', warning: 'Unsupported file type — paste the text below, or upload a PDF, DOCX, or TXT file.' };
}
