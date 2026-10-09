const fs = require('fs');
const path = require('path');

/**
 * What an uploaded file is allowed to be, shared by the upload route (which
 * filters and names the file) and the download route (which decides the
 * Content-Type it is served with).
 *
 * Anything a browser will execute if it ever renders the file is out. Documents
 * are served as attachments, but the safe list is kept narrow rather than
 * relying on one header: an employee document is an ID scan, a contract or a
 * certificate, and none of those are HTML.
 *
 * The extension is the one the stored file gets. It comes from the type (after
 * the bytes have been checked against it), never from the client's filename,
 * so `x.html` declared as a PDF is stored as `.pdf`.
 */
const DOCUMENT_TYPES = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
};

const DOCUMENT_MIME_ALLOW_LIST = Object.keys(DOCUMENT_TYPES);

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
// ISO-BMFF brands an iPhone (or anything else writing HEIF) puts after `ftyp`.
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);

const OFFICE_FOLDER = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'word/',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xl/',
};
// A real .docx or .xlsx has a few dozen parts, a few hundred with many
// embedded images; anything past this is not a document anyone typed.
const MAX_OFFICE_ENTRIES = 1000;
const MAX_CENTRAL_DIRECTORY = 1024 * 1024;
const EOCD = 0x06054b50;
const CENTRAL_ENTRY = 0x02014b50;

/**
 * True when the zip's central directory names `[Content_Types].xml` and at
 * least one part under `folder` — what makes a zip a Word or Excel file rather
 * than any archive renamed to .docx. Only the directory is read: nothing is
 * inflated, so this costs two small reads however large the file is. A zip64
 * or an implausible directory is refused rather than parsed — a 10 MB office
 * document never needs either.
 */
const hasOfficeParts = (fd, folder) => {
  const { size } = fs.fstatSync(fd);
  // The end record is 22 bytes plus a comment of at most 64 KB.
  const tailLength = Math.min(size, 22 + 0xffff);
  const tail = Buffer.alloc(tailLength);
  fs.readSync(fd, tail, 0, tailLength, size - tailLength);
  let end = -1;
  for (let i = tailLength - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === EOCD) { end = i; break; }
  }
  if (end === -1) return false;

  const count = tail.readUInt16LE(end + 10);
  const directorySize = tail.readUInt32LE(end + 12);
  const directoryOffset = tail.readUInt32LE(end + 16);
  if (count === 0 || count > MAX_OFFICE_ENTRIES) return false;
  if (directorySize > MAX_CENTRAL_DIRECTORY || directoryOffset + directorySize > size) return false;

  const directory = Buffer.alloc(directorySize);
  fs.readSync(fd, directory, 0, directorySize, directoryOffset);
  let contentTypes = false;
  let parts = false;
  let at = 0;
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > directorySize || directory.readUInt32LE(at) !== CENTRAL_ENTRY) return false;
    const nameLength = directory.readUInt16LE(at + 28);
    const next = at + 46 + nameLength + directory.readUInt16LE(at + 30) + directory.readUInt16LE(at + 32);
    if (next > directorySize) return false;
    const name = directory.toString('latin1', at + 46, at + 46 + nameLength);
    if (name === '[Content_Types].xml') contentTypes = true;
    else if (name.startsWith(folder)) parts = true;
    at = next;
  }
  return contentTypes && parts;
};

/**
 * Throws away a refused upload: the file, then its folder if that leaves it
 * empty. The document folder is created before the request is checked (multer
 * needs somewhere to write), so without the second step every refusal for an
 * employee with no documents left an empty folder behind. rmdir refuses a
 * folder that still holds anything, which is the "only if empty" check.
 */
const discardUpload = (file) => {
  if (!file || !file.path) return;
  fs.unlink(file.path, () => {
    fs.rmdir(path.dirname(file.path), () => {});
  });
};

/**
 * True when the file's first bytes really are the type it was declared as.
 * The declared type is just a request header, so it is what gets checked, not
 * trusted. Office Open XML must be a zip that carries the parts Word or Excel
 * would look for (see hasOfficeParts); the legacy OLE formats keep the magic
 * check alone.
 */
const hasSignature = (filePath, mimetype) => {
  const fd = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(12);
    const read = fs.readSync(fd, head, 0, 12, 0);
    if (read === 0) return false;
    switch (mimetype) {
      case 'application/pdf': return head.toString('latin1', 0, 5) === '%PDF-';
      case 'image/jpeg': return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
      case 'image/png': return head.subarray(0, 8).equals(PNG);
      case 'image/webp': return head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP';
      case 'image/heic': return head.toString('latin1', 4, 8) === 'ftyp' && HEIF_BRANDS.has(head.toString('latin1', 8, 12));
      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
        return head.subarray(0, 4).equals(ZIP) && hasOfficeParts(fd, OFFICE_FOLDER[mimetype]);
      case 'application/msword':
      case 'application/vnd.ms-excel':
        return head.subarray(0, 8).equals(OLE);
      default: return false;
    }
  } finally {
    fs.closeSync(fd);
  }
};

/**
 * The Content-Type a stored document is served with. `mimeType` was declared by
 * the client at upload, and before the type filter existed nothing stopped it
 * being text/html or image/svg+xml — so a legacy row only keeps its type if
 * that type is still one we would accept today.
 */
const servedContentType = (mimeType) =>
  (DOCUMENT_MIME_ALLOW_LIST.includes(mimeType) ? mimeType : 'application/octet-stream');

/**
 * RFC 6266 Content-Disposition: a plain-ASCII `filename` for old clients and a
 * UTF-8 `filename*` for everyone else. The ASCII form drops anything that could
 * end the quoted string or the header.
 */
const attachmentDisposition = (fileName) => {
  const name = String(fileName || 'document');
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
};

module.exports = { DOCUMENT_TYPES, DOCUMENT_MIME_ALLOW_LIST, hasSignature, discardUpload, servedContentType, attachmentDisposition };
