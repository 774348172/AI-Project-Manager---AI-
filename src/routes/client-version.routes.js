const express = require('express');
const { ok } = require('../lib/response');
const { getClientVersionStatus, getClientUpdateFile } = require('../services/client-version-service');

const router = express.Router();

function getServerBaseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

router.get('/client/version', async (req, res, next) => {
  try {
    res.json(ok(await getClientVersionStatus({
      version: req.query.version,
      platform: req.query.platform || 'windows',
      serverBaseUrl: getServerBaseUrl(req)
    })));
  } catch (error) {
    next(error);
  }
});

router.get('/client-updates/windows/latest.yml', async (req, res, next) => {
  try {
    const updateFile = await getClientUpdateFile('latest.yml');
    res.sendFile(updateFile.filePath);
  } catch (error) {
    next(error);
  }
});

router.get('/client-updates/windows/:fileName', async (req, res, next) => {
  try {
    const updateFile = await getClientUpdateFile(req.params.fileName);
    res.download(updateFile.filePath, updateFile.fileName);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
