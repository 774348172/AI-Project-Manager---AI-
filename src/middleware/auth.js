const { authenticateToken, unauthorized } = require('../services/auth-service');

function readBearerToken(req) {
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function requireAuth() {
  return async (req, res, next) => {
    try {
      const auth = await authenticateToken(readBearerToken(req));
      req.auth = auth;
      next();
    } catch (error) {
      next(error);
    }
  };
}

function optionalAuth() {
  return async (req, res, next) => {
    try {
      const token = readBearerToken(req);
      if (token) {
        req.auth = await authenticateToken(token);
      }
      next();
    } catch (error) {
      next(unauthorized('登录状态已失效，请重新登录。'));
    }
  };
}

module.exports = {
  optionalAuth,
  readBearerToken,
  requireAuth
};
