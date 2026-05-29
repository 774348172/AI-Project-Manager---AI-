function ok(data) {
  return { ok: true, data };
}

function fail(code, message) {
  return {
    ok: false,
    error: {
      code,
      message
    }
  };
}

function notImplemented() {
  return ok({
    implemented: false,
    message: 'Phase 1 only reserves this plugin interface.'
  });
}

module.exports = {
  ok,
  fail,
  notImplemented
};
