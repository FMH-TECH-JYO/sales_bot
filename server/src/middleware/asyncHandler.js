// server/src/middleware/asyncHandler.js
//
// Express does not catch rejected promises from async route handlers on its
// own — an unhandled rejection in an async controller crashes the whole
// process. Wrap every async controller function with this. It forwards any
// thrown error/rejected promise to next(), which routes it to the
// error-handling middleware in index.js instead of taking the server down.

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;