const express = require('express');
const {
  addShallowMemory,
  searchShallowMemory,
  addDeepMemoryIndex
} = require('../services/memory-service');
const { ok } = require('../lib/response');

const router = express.Router();

router.post('/memory/shallow', async (req, res, next) => {
  try {
    const { category, content, source } = req.body;
    res.json(ok(await addShallowMemory({ category, content, source })));
  } catch (error) {
    next(error);
  }
});

router.get('/memory/shallow', async (req, res, next) => {
  try {
    const { category, q } = req.query;
    res.json(ok({ results: await searchShallowMemory({ category, q }) }));
  } catch (error) {
    next(error);
  }
});

router.post('/memory/deep/index', async (req, res, next) => {
  try {
    const { category, title, path, tags, summary } = req.body;
    res.json(ok(await addDeepMemoryIndex({ category, title, path, tags, summary })));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
