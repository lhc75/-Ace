function stopBackendProcess(proc, requestStop, timeoutMs = 20000, logger = console) {
  if (!proc || proc.exitCode != null || proc.signalCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let killTimer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (killTimer !== null) clearTimeout(killTimer);
      proc.removeListener('exit', finish);
      resolve();
    };
    proc.once('exit', finish);
    const stopTimeoutMs = Math.max(1000, Math.min(15000, timeoutMs - 5000));
    Promise.resolve()
      .then(() => requestStop(stopTimeoutMs))
      .catch((error) => logger.warn('[py] stop request failed:', error.message))
      .then(() => {
        if (settled) return;
        try { proc.kill('SIGTERM'); } catch (error) { logger.warn('[py] SIGTERM failed:', error.message); }
        if (settled) return;
        killTimer = setTimeout(() => {
          if (settled) return;
          // ChildProcess.killed only records signal delivery; wait for exit instead.
          try {
            logger.warn('[py] graceful timeout, escalating to SIGKILL');
            proc.kill('SIGKILL');
          } catch (error) {
            logger.warn('[py] SIGKILL failed:', error.message);
          }
          finish();
        }, Math.max(1000, timeoutMs - stopTimeoutMs));
      });
  });
}

module.exports = { stopBackendProcess };
