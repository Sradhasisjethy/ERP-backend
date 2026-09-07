const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const controller = require('./vehicles.controller');
const schema = require('./vehicles.schema');

const vehiclesRouter = Router();

vehiclesRouter.use(authenticate, tenantScope, auditContext);

vehiclesRouter.get('/', authorize('VEHICLE_READ'), validate(schema.listQuerySchema, 'query'), controller.listVehicles);
vehiclesRouter.post('/', authorize('VEHICLE_CREATE'), validate(schema.createVehicleSchema), controller.createVehicle);
vehiclesRouter.get('/:id', authorize('VEHICLE_READ'), controller.getVehicle);
vehiclesRouter.put('/:id', authorize('VEHICLE_MODIFY'), validate(schema.updateVehicleSchema), controller.updateVehicle);
// Deactivates rather than deletes — see VehicleService.remove.
vehiclesRouter.delete('/:id', authorize('VEHICLE_DELETE'), controller.deleteVehicle);

module.exports = { vehiclesRouter };
