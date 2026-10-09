const { asyncHandler } = require('../../core/asyncHandler');
const { userService } = require('./user.service');
const { sendSuccess } = require('../../utils/response');
const { AppError, NotFoundError, ValidationError } = require('../../core/AppError');
const { getTenantId } = require('../../core/tenantContext');
const { EmployeeDocument } = require('./employeeDocument.model');
const { servedContentType, attachmentDisposition, discardUpload } = require('./documentFiles');
const fs = require('fs');
const path = require('path');

const EMPLOYEE_UPLOADS = path.join(__dirname, '../../../uploads/employees');
const MAX_DISPLAY_NAME = 200;

/**
 * The name a document is listed and downloaded under. It is display text only
 * — the file on disk is named by the server — so it keeps whatever script the
 * person wrote it in. The old rule replaced every non-ASCII-word character, so
 * 'प्रमाण.pdf' was listed as '______.pdf'. Removed now are only what could
 * mislead or break something downstream: control characters (and the bidi
 * overrides that make 'cod.exe' read as 'exe.doc'), path separators, quotes
 * and the characters Windows refuses in a filename when it is saved again.
 * Tail-trimmed so the extension the user will recognise survives the cap.
 */
const displayFileName = (original) => {
  const lastSegment = String(original || '').split(/[\\/]/).pop();
  const cleaned = lastSegment
    .normalize('NFC')
    // Whitespace first, so a tab or newline becomes a space rather than vanishing.
    .replace(/\s+/g, ' ')
    .replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, '')
    .replace(/["'`<>:|?*]/g, '_')
    .trim();
  // By code point, so a cut never splits a surrogate pair.
  const capped = Array.from(cleaned).slice(-MAX_DISPLAY_NAME).join('').trim();
  return capped || 'document';
};

/**
 * Where a document's bytes live, from the id the database stored rather than
 * the one in the URL: the URL id is only matched against, and the same UUID can
 * be spelled in either case. Null when the resolved path would leave the folder.
 */
const storedPath = (doc) => {
  const dir = path.join(EMPLOYEE_UPLOADS, String(doc.employeeId).toLowerCase());
  const filePath = path.resolve(dir, doc.fileKey);
  return filePath.startsWith(path.resolve(dir) + path.sep) ? filePath : null;
};
const list = asyncHandler(async (req, res) => {
  const result = await userService.list(req.query, req.user);
  sendSuccess(res, result);
});

const getById = asyncHandler(async (req, res) => {
  const user = await userService.getById(req.params.id, req.user);
  sendSuccess(res, user);
});

const create = asyncHandler(async (req, res) => {
  const user = await userService.create(req.body, req.user);
  sendSuccess(res, user, 'User created successfully', 201);
});

const update = asyncHandler(async (req, res) => {
  const user = await userService.update(req.params.id, req.body, req.user);
  sendSuccess(res, user, 'User updated successfully');
});

const deleteUser = asyncHandler(async (req, res) => {
  await userService.delete(req.params.id, req.user);
  sendSuccess(res, null, 'Employee deleted');
});

const uploadDocument = asyncHandler(async (req, res) => {
  if (!req.file) throw new ValidationError('No file uploaded');
  // The file is already on disk by now, so every refusal below — and a failed
  // insert — must take it with it, or a rejected request still costs disk
  // space and leaves a file no row points to.
  try {
    // The tenant hooks fail open when the CLS context is missing, which would
    // turn the employee lookup below into an unscoped one. A lost context is
    // our fault, not the client's, so it is a 500 — but never a cross-tenant write.
    if (!getTenantId()) throw new AppError('The request lost its organisation context. Please try again.', 500);

    // Lowercase, as the folder multer wrote into was (see user.router.js).
    const employeeId = req.params.id.toLowerCase();
    const documentType = typeof req.body.documentType === 'string' ? req.body.documentType.trim() : '';
    if (!documentType) throw new ValidationError('Document type is required');
    if (documentType.length > 100) throw new ValidationError('Document type must be at most 100 characters');

    // Tenant-scoped: a document can only be attached to an employee of this
    // tenant. The id was taken on trust, so a file could be filed against any
    // UUID, including another tenant's employee or none at all.
    const { User } = require('./user.model');
    if (!(await User.findByPk(employeeId, { attributes: ['id'] }))) {
      throw new NotFoundError('Employee not found');
    }

    // Display name only — the stored file is named by the server (fileKey),
    // with the extension of its verified type.
    const fileName = displayFileName(req.file.originalname);

    const doc = await EmployeeDocument.create({
      employeeId,
      documentType,
      fileName,
      fileKey: req.file.filename,
      fileSize: req.file.size,
      mimeType: req.file.mimetype,
    });

    sendSuccess(res, doc, 'Document uploaded successfully', 201);
  } catch (error) {
    discardUpload(req.file);
    throw error;
  }
});

const listDocuments = asyncHandler(async (req, res) => {
  const employeeId = req.params.id;
  const docs = await EmployeeDocument.findAll({ where: { employeeId } });

  const withUrls = docs.map((doc) => ({
    ...doc.toJSON(),
    /**
     * An API path, not a filesystem URL.
     *
     * This used to be `${BACKEND_URL}/uploads/employees/<id>/<fileKey}`, served
     * by an `express.static` mount that ran before any router — no
     * authentication, no tenant check. Listing the documents was gated, but the
     * bytes were not, so the permission check decided only who was *told* the
     * address of an offer letter or an ID scan, and anyone holding the address
     * afterwards could fetch it, logged in or not, from any tenant.
     *
     * The frontend opens this through `openApiDocument`, which sends it with
     * credentials like every other call — see that helper for why a plain
     * `<a href>` cannot be used across origins.
     */
    url: `/users/${doc.employeeId}/documents/${doc.id}/file`,
  }));

  sendSuccess(res, withUrls, 'Documents retrieved successfully');
});

/**
 * Streams one document, after proving it belongs to the employee named in the
 * path. EmployeeDocument is a scoped model, so the tenant filter is applied by
 * the base-model hook and a document from another tenant simply is not found.
 */
const downloadDocument = asyncHandler(async (req, res) => {
  const { id, documentId } = req.params;
  const doc = await EmployeeDocument.findOne({ where: { id: documentId, employeeId: id } });
  if (!doc) throw new NotFoundError('Document not found');

  // `fileKey` is generated server-side, but it still reaches the filesystem, so
  // resolve it and refuse anything that climbs out of the employee's folder.
  const filePath = storedPath(doc);
  if (!filePath) throw new NotFoundError('Document not found');
  if (!fs.existsSync(filePath)) throw new NotFoundError('Document file is missing');

  // `attachment` rather than inline: these are user-supplied files served from
  // the API origin, and a rendered .html or .svg would run as same-origin script.
  // The stored type is the client's own claim, and rows from before the type
  // filter can say text/html — so only an allow-listed type is echoed back.
  res.setHeader('Content-Type', servedContentType(doc.mimeType));
  res.setHeader('Content-Disposition', attachmentDisposition(doc.fileName));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // An ID scan or an offer letter must not linger in a shared or proxy cache.
  res.setHeader('Cache-Control', 'private, no-store');
  fs.createReadStream(filePath).pipe(res);
});

const deleteDocument = asyncHandler(async (req, res) => {
  const { id, documentId } = req.params;
  const doc = await EmployeeDocument.findOne({ where: { id: documentId, employeeId: id } });
  if (!doc) throw new NotFoundError('Document not found');

  if (doc.isVerified) {
    throw new ValidationError('Cannot delete a verified document. It must be unverified first.');
  }

  // Row first, file second: if the delete fails the document is still listed
  // and still downloadable, instead of a row pointing at a file that is gone.
  // A file left behind by a failed unlink is only wasted space.
  await doc.destroy();

  const filePath = storedPath(doc);
  if (filePath) {
    fs.unlink(filePath, (error) => {
      if (error && error.code !== 'ENOENT') console.error('Error deleting local file:', error);
      // The last document out takes the folder with it; rmdir refuses one
      // that still holds anything.
      if (!error) fs.rmdir(path.dirname(filePath), () => {});
    });
  }

  sendSuccess(res, null, 'Document deleted successfully');
});

const verifyDocument = asyncHandler(async (req, res) => {
  const { id, documentId } = req.params;
  // A boolean, guaranteed by verifyDocumentSchema.
  const { isVerified } = req.body;

  const doc = await EmployeeDocument.findOne({ where: { id: documentId, employeeId: id } });
  if (!doc) throw new NotFoundError('Document not found');

  doc.isVerified = isVerified;
  await doc.save();

  // From what was stored, so the message cannot disagree with the row.
  sendSuccess(res, doc, `Document ${doc.isVerified ? 'verified' : 'unverified'} successfully`);
});

const uploadAvatar = asyncHandler(async (req, res) => {
  if (!req.file) throw new ValidationError('No image file uploaded');
  const url = `/uploads/avatars/${req.file.filename}`;
  sendSuccess(res, { url, filename: req.file.filename, size: req.file.size }, 'Avatar uploaded successfully', 201);
});

module.exports = { list, getById, create, update, deleteUser, uploadDocument, listDocuments, downloadDocument, deleteDocument, verifyDocument, uploadAvatar };
