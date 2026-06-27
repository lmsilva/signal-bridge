function formatError(err) {
  if (!err) {
    return 'unknown error';
  }

  if (err instanceof AggregateError || err.name === 'AggregateError') {
    const causes = (err.errors || [])
      .map((e) => (e?.message ? e.message : String(e)))
      .filter(Boolean);
    if (causes.length) {
      return `AggregateError: ${causes.join('; ')}`;
    }
  }

  if (err.cause) {
    const causeMsg = err.cause?.message || String(err.cause);
    const base = err.message || String(err);
    if (causeMsg && causeMsg !== base) {
      return `${base}: ${causeMsg}`;
    }
  }

  return err.message || String(err);
}

function isAggregateError(err) {
  return err instanceof AggregateError || err?.name === 'AggregateError';
}

module.exports = {
  formatError,
  isAggregateError,
};
