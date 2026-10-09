// Files a flow uploads.
//
// A form that needs a PDF attached can be satisfied three ways, and the step
// says which:
//
//   stored — the bytes captured when the flow was recorded (or attached later
//            in the editor), kept inside the flow's own directory. The flow
//            replays identically on any machine.
//   path   — a file on this machine, read at replay time. For a document that
//            changes between runs (this month's invoice), or one too large or
//            too sensitive to copy into the flow.
//   sample — a small valid file of the right kind generated on the spot, for a
//            form that only needs *a* PDF and does not care which.
//
// Every source ends as the same thing Playwright's setInputFiles takes: a list
// of { name, mimeType, buffer }.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { sessionDir } from './store.js';

export const SOURCES = ['stored', 'path', 'sample'];
export const SAMPLE_KINDS = ['pdf', 'png', 'txt', 'csv', 'docx'];

export function uploadsDir(flowId) {
  return path.join(sessionDir(flowId), 'uploads');
}

// A file name as a page reported it, reduced to one that cannot leave the
// uploads directory and is still recognisably the same file.
export function safeFileName(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/'));
  const cleaned = base.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_').replace(/^\.+/, '').slice(0, 120);
  return cleaned || 'file';
}

// Writes a captured or attached file into the flow and returns its descriptor.
// Files with no bytes (over the recorder's cap, or unreadable) are kept by name
// with `missing: true`, so the editor can ask for them instead of replay
// pretending it has something to upload.
export function storeUpload(flowId, file) {
  const name = safeFileName(file && file.name);
  const meta = { name, type: (file && file.type) || mimeFor(name), size: (file && file.size) || 0 };
  if (!file || typeof file.data !== 'string' || !file.data) return { ...meta, stored: null, missing: true };
  const dir = uploadsDir(flowId);
  fs.mkdirSync(dir, { recursive: true });
  // Prefixed so two files of the same name in one flow do not overwrite each
  // other, and so the stored name never collides with a user-chosen one.
  const stored = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}-${name}`;
  const bytes = Buffer.from(file.data, 'base64');
  fs.writeFileSync(path.join(dir, stored), bytes);
  return { ...meta, size: bytes.length, stored };
}

// Removes a flow's stored files that no step refers to any more, so replacing
// an attachment in the editor does not leave the old one behind for good.
export function pruneUploads(flowId, steps) {
  const dir = uploadsDir(flowId);
  if (!fs.existsSync(dir)) return;
  const used = new Set();
  for (const step of steps) {
    for (const f of (step.file && step.file.files) || []) if (f.stored) used.add(f.stored);
  }
  for (const entry of fs.readdirSync(dir)) {
    if (!used.has(entry)) fs.rmSync(path.join(dir, entry), { force: true });
  }
}

const MIME = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export function mimeFor(name) {
  const ext = path.extname(String(name || '')).slice(1).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

// The files a step will upload, ready for setInputFiles. Throws with a message
// a person can act on when the file is not there: an upload step that quietly
// uploads nothing passes, and the form it fed then fails somewhere far away.
export function filesForStep(flowId, step) {
  const spec = step.file || {};
  const source = spec.source || 'stored';
  if (source === 'path') {
    const paths = (spec.paths || []).filter((p) => typeof p === 'string' && p.trim());
    if (!paths.length) throw uploadError(step, 'is set to upload a file from disk, but no file was chosen');
    return paths.map((p) => {
      const full = path.resolve(p.trim());
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
        throw uploadError(step, `cannot find ${full} on this machine`);
      }
      const name = path.basename(full);
      return { name, mimeType: mimeFor(name), buffer: fs.readFileSync(full) };
    });
  }
  if (source === 'sample') {
    const kind = SAMPLE_KINDS.includes(spec.sample) ? spec.sample : 'pdf';
    const name = spec.name ? safeFileName(spec.name) : `sample.${kind}`;
    return [{ name, mimeType: mimeFor(`x.${kind}`), buffer: sampleFile(kind, name) }];
  }
  const files = spec.files || [];
  if (!files.length) throw uploadError(step, 'has no file attached');
  return files.map((f) => {
    if (f.missing || !f.stored) {
      throw uploadError(step, `recorded "${f.name}" but its contents were not kept — attach it in the step editor`);
    }
    const full = path.join(uploadsDir(flowId), path.basename(f.stored));
    if (!fs.existsSync(full)) throw uploadError(step, `stored copy of "${f.name}" is gone from the flow`);
    return { name: f.name, mimeType: f.type || mimeFor(f.name), buffer: fs.readFileSync(full) };
  });
}

function uploadError(step, what) {
  const err = new Error(`upload step ${step.index} ${what}`);
  err.code = 'upload-missing';
  return err;
}

// ---- generated samples -----------------------------------------------------
// Real, valid files rather than renamed text: a form that checks the PDF header
// or decodes the image must accept them, or the sample is no use as a stand-in.

function sampleFile(kind, name) {
  switch (kind) {
    case 'png':
      return samplePng();
    case 'txt':
      return Buffer.from(`Sample file generated by Record for ${name}.\n`, 'utf8');
    case 'csv':
      return Buffer.from('id,name,amount\n1,Sample,10.00\n2,Example,20.50\n', 'utf8');
    case 'docx':
      return sampleDocx();
    default:
      return samplePdf(`Sample document generated by Record (${name})`);
  }
}

// A one-page PDF with a line of text and a correct cross-reference table, so
// strict parsers (pdf.js, server-side validators) open it without repair.
export function samplePdf(text) {
  const safe = String(text).replace(/[\\()]/g, (c) => `\\${c}`);
  const stream = `BT /F1 18 Tf 72 720 Td (${safe}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) out += `${String(at).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ---- tiny binary encoders (no dependencies) --------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// A 32x32 solid-colour PNG, deflated with zlib.
function samplePng() {
  const w = 32;
  const h = 32;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x++) raw.set([37, 99, 235], row + 1 + x * 3);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// A minimal Word document: a stored (uncompressed) ZIP with the three parts
// Word needs to open it.
function sampleDocx() {
  const parts = {
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml':
      '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Sample document generated by Record.</w:t></w:r></w:p></w:body></w:document>',
  };
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(parts)) {
    const data = Buffer.from(text, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(parts).length, 8);
  end.writeUInt16LE(Object.keys(parts).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
