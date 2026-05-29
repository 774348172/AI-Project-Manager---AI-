const express = require('express');

const router = express.Router();

router.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'baize-local-hub',
    phase: '1'
  });
});

module.exports = router;
