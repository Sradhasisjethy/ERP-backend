const { asyncHandler } = require('../../core/asyncHandler');
const { userService } = require('./user.service');
const { sendSuccess } = require('../../utils/response');
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
  const user = await userService.create(req.body);
  sendSuccess(res, user, 'User created successfully', 201);
});

const update = asyncHandler(async (req, res) => {
  const user = await userService.update(req.params.id, req.body);
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
  
  const backendUrl = process.env.BACKEND_URL || 'http://localhost:3001';

  const withUrls = docs.map((doc) => {
    // Generate static url
    const url = `${backendUrl}/uploads/employees/${employeeId}/${doc.fileKey}`;
    return { ...doc.toJSON(), url };
  });

  sendSuccess(res, withUrls, 'Documents retrieved successfully');
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

module.exports = { list, getById, create, update, deleteUser, uploadDocument, listDocuments, deleteDocument, verifyDocument, uploadAvatar };
