/**
 * RFC 6266 Content-Disposition with an RFC 5987 `filename*`.
 *
 * Document numbers carry the plant code, and a legacy code can hold a quote
 * (which ends the quoted filename early) or a non-Latin-1 character (which
 * makes Node's setHeader throw, so every PDF of that plant was a 500). The
 * plain `filename` is reduced to printable ASCII for old clients; `filename*`
 * carries the real name, percent-encoded, for everyone else.
 *
 * Same shape as users/documentFiles.attachmentDisposition, but printed
 * documents open in the browser, so the disposition type is a parameter.
 */
const contentDisposition = (fileName, type = 'attachment') => {
  const disposition = type === 'inline' ? 'inline' : 'attachment';
  const name = String(fileName || 'document');
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
};

module.exports = { contentDisposition };
