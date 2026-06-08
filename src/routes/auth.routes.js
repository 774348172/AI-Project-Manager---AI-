const express = require('express');
const { ok } = require('../lib/response');
const { registerUser, loginUser, logoutToken, updateUserJiraDefaults } = require('../services/auth-service');
const { readBearerToken, requireAuth } = require('../middleware/auth');

const router = express.Router();

function publicSession(session) {
  if (!session) {
    return null;
  }
  const { tokenHash, ...safeSession } = session;
  return safeSession;
}

router.post('/auth/register', async (req, res, next) => {
  try {
    const result = await registerUser(req.body || {});
    res.json(ok({
      user: result.user,
      token: result.token,
      session: publicSession(result.session)
    }));
  } catch (error) {
    next(error);
  }
});

router.post('/auth/login', async (req, res, next) => {
  try {
    const result = await loginUser(req.body || {});
    res.json(ok({
      user: result.user,
      token: result.token,
      session: publicSession(result.session)
    }));
  } catch (error) {
    next(error);
  }
});

router.get('/auth/me', requireAuth(), async (req, res) => {
  res.json(ok({ user: req.auth.user, session: publicSession(req.auth.session) }));
});

router.patch('/auth/me/jira-defaults', requireAuth(), async (req, res, next) => {
  try {
    res.json(ok(await updateUserJiraDefaults(req.auth.user.id, req.body || {})));
  } catch (error) {
    next(error);
  }
});

router.post('/auth/logout', async (req, res, next) => {
  try {
    res.json(ok(await logoutToken(readBearerToken(req))));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
