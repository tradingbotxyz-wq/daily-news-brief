// Runs the full app test suite against the Turso (HTTP) database backend.
process.env.TEST_BACKEND = 'turso';
require('./app.test.js');
