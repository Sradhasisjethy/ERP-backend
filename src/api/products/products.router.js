const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const controller = require('./products.controller');
const schema = require('./products.schema');

const productsRouter = Router();

productsRouter.use(authenticate, tenantScope, auditContext);

// UoM
productsRouter.get('/uoms', authorize('PRODUCT_READ'), validate(schema.listQuerySchema, 'query'), controller.listUoms);
productsRouter.post('/uoms', authorize('PRODUCT_CREATE'), validate(schema.createUomSchema), controller.createUom);
productsRouter.get('/uoms/:id', authorize('PRODUCT_READ'), controller.getUom);
productsRouter.put('/uoms/:id', authorize('PRODUCT_MODIFY'), validate(schema.updateUomSchema), controller.updateUom);
productsRouter.delete('/uoms/:id', authorize('PRODUCT_DELETE'), controller.deleteUom);

// Product Categories
productsRouter.get('/product-categories', authorize('PRODUCT_READ'), validate(schema.listQuerySchema, 'query'), controller.listProductCategories);
productsRouter.post('/product-categories', authorize('PRODUCT_CREATE'), validate(schema.createProductCategorySchema), controller.createProductCategory);
productsRouter.get('/product-categories/:id', authorize('PRODUCT_READ'), controller.getProductCategory);
productsRouter.put('/product-categories/:id', authorize('PRODUCT_MODIFY'), validate(schema.updateProductCategorySchema), controller.updateProductCategory);
productsRouter.delete('/product-categories/:id', authorize('PRODUCT_DELETE'), controller.deleteProductCategory);

// HSN Codes
productsRouter.get('/hsn-codes', authorize('PRODUCT_READ'), validate(schema.listQuerySchema, 'query'), controller.listHsnCodes);
productsRouter.post('/hsn-codes', authorize('PRODUCT_CREATE'), validate(schema.createHsnCodeSchema), controller.createHsnCode);
productsRouter.get('/hsn-codes/:id', authorize('PRODUCT_READ'), controller.getHsnCode);
productsRouter.put('/hsn-codes/:id', authorize('PRODUCT_MODIFY'), validate(schema.updateHsnCodeSchema), controller.updateHsnCode);
productsRouter.delete('/hsn-codes/:id', authorize('PRODUCT_DELETE'), controller.deleteHsnCode);

// Products
productsRouter.get('/products', authorize('PRODUCT_READ'), validate(schema.listQuerySchema, 'query'), controller.listProducts);
productsRouter.post('/products', authorize('PRODUCT_CREATE'), validate(schema.createProductSchema), controller.createProduct);
productsRouter.get('/products/:id', authorize('PRODUCT_READ'), controller.getProduct);
productsRouter.put('/products/:id', authorize('PRODUCT_MODIFY'), validate(schema.updateProductSchema), controller.updateProduct);
productsRouter.delete('/products/:id', authorize('PRODUCT_DELETE'), controller.deleteProduct);

// Mix Designs (BOM)
// UoM conversions (FR-M03-2). Registered before /uoms/:id so "conversions"
// is never captured as a UoM id.
productsRouter.get('/uom-conversions', authorize('PRODUCT_READ'), validate(schema.listQuerySchema, 'query'), controller.listUomConversions);
productsRouter.post('/uom-conversions', authorize('PRODUCT_CREATE'), validate(schema.createUomConversionSchema), controller.createUomConversion);
productsRouter.put('/uom-conversions/:id', authorize('PRODUCT_MODIFY'), validate(schema.updateUomConversionSchema), controller.updateUomConversion);
productsRouter.delete('/uom-conversions/:id', authorize('PRODUCT_DELETE'), controller.deleteUomConversion);
productsRouter.get('/uom-convert', authorize('PRODUCT_READ'), validate(schema.convertQuerySchema, 'query'), controller.convertUom);

productsRouter.get('/mix-designs', authorize('PRODUCT_READ'), validate(schema.listQuerySchema, 'query'), controller.listMixDesigns);
productsRouter.post('/mix-designs', authorize('PRODUCT_CREATE'), validate(schema.createMixDesignSchema), controller.createMixDesign);
productsRouter.get('/mix-designs/:id', authorize('PRODUCT_READ'), controller.getMixDesign);
productsRouter.put('/mix-designs/:id', authorize('PRODUCT_MODIFY'), validate(schema.updateMixDesignSchema), controller.updateMixDesign);
productsRouter.put('/mix-designs/:id/activate', authorize('PRODUCT_MODIFY'), validate(schema.activateMixDesignSchema), controller.activateMixDesign);
productsRouter.post('/mix-designs/:id/clone', authorize('PRODUCT_CREATE'), validate(schema.cloneMixDesignSchema), controller.cloneMixDesign);
productsRouter.get('/mix-designs/:id/explode', authorize('PRODUCT_READ'), validate(schema.explodeQuerySchema, 'query'), controller.explodeMixDesign);
productsRouter.get('/mix-designs/:id/cost', authorize('PRODUCT_READ'), controller.mixDesignCost);
productsRouter.delete('/mix-designs/:id', authorize('PRODUCT_DELETE'), controller.deleteMixDesign);

module.exports = { productsRouter };
