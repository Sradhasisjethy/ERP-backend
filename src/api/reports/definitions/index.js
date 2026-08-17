/**
 * Loads every report definition. Requiring a definition file registers its
 * reports as a side effect (see lib/registry.js#defineReport), so this module
 * is the single import the rest of the system needs — and the single place a
 * new report category gets switched on.
 */
require('./sales');
require('./orders');
require('./purchase');
require('./production');
require('./inventory');
require('./ageing');
require('./parties');
require('./labour');
require('./finance');
require('./analytics');

module.exports = require('../lib/registry');
