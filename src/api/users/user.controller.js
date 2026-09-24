const { asyncHandler } = require('../../core/asyncHandler');
const { userService } = require('./user.service');
const { sendSuccess } = require('../../utils/response');
const { NotFoundError } = require('../../core/AppError');
const { EmployeeDocument } = require('./employeeDocument.model');
const fs = require('fs');
const path = require('path');
const { env } = require('../../config/env');
const list = asyncHandler(async (req, res) => {
  const result = await userService.list(req.query);
  sendSuccess(res, result);
});

const getById = asyncHandler(async (req, res) => {
  const user = await userService.getById(req.params.id);
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
  await userService.delete(req.params.id);
  sendSuccess(res, null, 'Employee deleted');
});

const uploadDocument = asyncHandler(async (req, res) => {
  if (!req.file) throw new Error('No file uploaded');
  const employeeId = req.params.id;
  const { documentType } = req.body;
  if (!documentType) throw new Error('Document type is required');

  const fileKey = req.file.filename;

  const doc = await EmployeeDocument.create({
    employeeId,
    documentType,
    fileName: req.file.originalname,
    fileKey,
    fileSize: req.file.size,
    mimeType: req.file.mimetype,
  });

  sendSuccess(res, doc, 'Document uploaded successfully', 201);
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
    url: `/users/${employeeId}/documents/${doc.id}/file`,
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
  const dir = path.join(__dirname, '../../../uploads/employees', id);
  const filePath = path.resolve(dir, doc.fileKey);
  if (!filePath.startsWith(path.resolve(dir) + path.sep)) {
    throw new NotFoundError('Document not found');
  }
  if (!fs.existsSync(filePath)) throw new NotFoundError('Document file is missing');

  // `attachment` rather than inline: these are user-supplied files served from
  // the API origin, and a rendered .html or .svg would run as same-origin script.
  res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.fileName)}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  fs.createReadStream(filePath).pipe(res);
});

const deleteDocument = asyncHandler(async (req, res) => {
  const { id, documentId } = req.params;
  const doc = await EmployeeDocument.findOne({ where: { id: documentId, employeeId: id } });
  if (!doc) throw new Error('Document not found');

  if (doc.isVerified) {
    throw new Error('Cannot delete a verified document. It must be unverified first.');
  }

  const filePath = path.join(__dirname, '../../../uploads/employees', id, doc.fileKey);
  
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error('Error deleting local file:', error);
  }

  await doc.destroy();
  sendSuccess(res, null, 'Document deleted successfully');
});

const verifyDocument = asyncHandler(async (req, res) => {
  const { id, documentId } = req.params;
  const { isVerified } = req.body;
  
  const doc = await EmployeeDocument.findOne({ where: { id: documentId, employeeId: id } });
  if (!doc) throw new Error('Document not found');
  
  doc.isVerified = isVerified;
  await doc.save();
  
  sendSuccess(res, doc, `Document ${isVerified ? 'verified' : 'unverified'} successfully`);
});

const uploadAvatar = asyncHandler(async (req, res) => {
  if (!req.file) throw new Error('No image file uploaded');
  const url = `/uploads/avatars/${req.file.filename}`;
  sendSuccess(res, { url, filename: req.file.filename, size: req.file.size }, 'Avatar uploaded successfully', 201);
});

module.exports = { list, getById, create, update, deleteUser, uploadDocument, listDocuments, downloadDocument, deleteDocument, verifyDocument, uploadAvatar };
