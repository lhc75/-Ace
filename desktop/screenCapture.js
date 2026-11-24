const DEFAULT_HIDE_SETTLE_MS = 180;
const DEFAULT_PROTECTION_SETTLE_MS = 80;

function isUsableWindow(win) {
  return Boolean(
    win
    && (typeof win.isDestroyed !== 'function' || !win.isDestroyed()),
  );
}

function isVisibleWindow(win) {
  if (!isUsableWindow(win) || typeof win.isVisible !== 'function') return false;
  try {
    return Boolean(win.isVisible());
  } catch {
    return false;
  }
}

function displayKey(display) {
  if (!display) return '';
  if (display.id !== undefined && display.id !== null) return `id:${display.id}`;
  const bounds = display.bounds || {};
  return `bounds:${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
}

/**
 * Prefer the display under the pointer, then the primary display, then every
 * other display. Capturing by explicit bounds avoids screencapture's ambiguous
 * `-m` behavior on multi-monitor setups.
 */
function orderDisplaysForCapture(allDisplays = [], primaryDisplay = null, cursorDisplay = null) {
  const ordered = [];
  const seen = new Set();
  for (const display of [cursorDisplay, primaryDisplay, ...allDisplays]) {
    if (!display) continue;
    const key = displayKey(display);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    ordered.push(display);
  }
  return ordered;
}

function analyzeBitmap(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return { blank: true, samples: 0, minLuma: 0, maxLuma: 0, stdDev: 0, transparentRatio: 1 };
  }

  const pixelCount = Math.floor(buffer.length / 4);
  const step = Math.max(1, Math.floor(pixelCount / 4096));
  let samples = 0;
  let transparent = 0;
  let minLuma = 255;
  let maxLuma = 0;
  let sum = 0;
  let sumSquares = 0;

  for (let pixel = 0; pixel < pixelCount; pixel += step) {
    const offset = pixel * 4;
    const alpha = buffer[offset + 3];
    if (alpha < 8) {
      transparent += 1;
      continue;
    }
    // BGRA and RGBA both produce a stable luminance signal for blank detection;
    // only R and B are swapped, which does not affect a uniform-image decision.
    const luma = 0.114 * buffer[offset]
      + 0.587 * buffer[offset + 1]
      + 0.299 * buffer[offset + 2];
    minLuma = Math.min(minLuma, luma);
    maxLuma = Math.max(maxLuma, luma);
    sum += luma;
    sumSquares += luma * luma;
    samples += 1;
  }

  if (samples === 0) {
    return { blank: true, samples: 0, minLuma: 0, maxLuma: 0, stdDev: 0, transparentRatio: 1 };
  }

  const mean = sum / samples;
  const variance = Math.max(0, sumSquares / samples - mean * mean);
  const stdDev = Math.sqrt(variance);
  const transparentRatio = transparent / (transparent + samples);
  return {
    blank: transparentRatio > 0.995 || (maxLuma - minLuma <= 4 && stdDev <= 1),
    samples,
    minLuma,
    maxLuma,
    stdDev,
    transparentRatio,
  };
}

/**
 * Hide the app windows and temporarily clear the macOS native capture-exclusion
 * shape while they are off-screen. The shape is re-applied before either window
 * is shown again, so screen sharing remains protected outside this short task.
 */
function createScreenCaptureCoordinator({
  getMainWindow,
  getOverlayWindow,
  getProtectionEnabled = () => true,
  setProtection,
  showOverlay = () => {},
  wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  platform = process.platform,
  hideSettleMs = DEFAULT_HIDE_SETTLE_MS,
  protectionSettleMs = DEFAULT_PROTECTION_SETTLE_MS,
  onError = () => {},
} = {}) {
  if (typeof getMainWindow !== 'function' || typeof getOverlayWindow !== 'function') {
    throw new TypeError('window getters are required');
  }
  if (typeof setProtection !== 'function') {
    throw new TypeError('setProtection must be a function');
  }

  let inFlight = null;

  function run(task) {
    if (typeof task !== 'function') return Promise.reject(new TypeError('task must be a function'));
    if (inFlight) return inFlight;

    const operation = (async () => {
      const main = getMainWindow();
      const overlay = getOverlayWindow();
      const windows = [main, overlay].filter(isUsableWindow);
      const mainWasVisible = isVisibleWindow(main);
      const overlayWasVisible = isVisibleWindow(overlay);
      const protectedWindows = windows.map((win) => ({
        win,
        enabled: win._captureProtectionEnabled !== false && Boolean(getProtectionEnabled()),
      }));

      try {
        if (overlayWasVisible) overlay.hide();
        if (mainWasVisible) main.hide();
        if (overlayWasVisible || mainWasVisible) await wait(hideSettleMs);

        const suspended = [];
        if (platform === 'darwin') {
          for (const entry of protectedWindows) {
            if (!entry.enabled || !isUsableWindow(entry.win)) continue;
            try {
              setProtection(entry.win, false);
              suspended.push(entry);
            } catch (error) {
              onError(error, 'suspend');
            }
          }
          if (suspended.length > 0) await wait(protectionSettleMs);
        }

        return await task({ main, overlay, mainWasVisible, overlayWasVisible });
      } finally {
        if (platform === 'darwin') {
          for (const entry of protectedWindows) {
            if (!entry.enabled || !isUsableWindow(entry.win)) continue;
            try {
              setProtection(entry.win, Boolean(getProtectionEnabled()));
            } catch (error) {
              onError(error, 'restore');
            }
          }
        }

        if (mainWasVisible && isUsableWindow(main)) {
          try {
            main.show();
          } catch (error) {
            onError(error, 'show-main');
          }
        }
        if (overlayWasVisible && isUsableWindow(overlay)) {
          try {
            showOverlay();
          } catch (error) {
            onError(error, 'show-overlay');
          }
        }
      }
    })();

    inFlight = operation;
    operation.finally(() => {
      if (inFlight === operation) inFlight = null;
    }).catch(() => {});
    return operation;
  }

  return run;
}

module.exports = {
  analyzeBitmap,
  createScreenCaptureCoordinator,
  orderDisplaysForCapture,
};
