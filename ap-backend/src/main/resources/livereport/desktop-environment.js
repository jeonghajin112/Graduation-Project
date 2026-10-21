// Run before any upstream script, and only inside rewritten viewer documents.
// The dashboard keeps the real device identity and touch events remain native.
(() => {
  const userAgent = bridgeConfig.desktopUserAgent;
  const define = (target, name, value) => {
    try {
      Object.defineProperty(target, name, { configurable: true, get: () => value });
    } catch { /* A locked browser property must not prevent the bridge loading. */ }
  };
  define(navigator, 'userAgent', userAgent);
  define(navigator, 'appVersion', userAgent.replace(/^Mozilla\//, ''));
  define(navigator, 'platform', 'Win32');
  define(navigator, 'maxTouchPoints', 0);

  // Client hints are another common mobile detector in Chromium. Do not add
  // this API to engines that do not support it (for example Safari).
  if (navigator.userAgentData) {
    const version = /Chrome\/([\d.]+)/.exec(userAgent)?.[1] || '146.0.0.0';
    const brands = [{ brand: 'Chromium', version: version.split('.')[0] }];
    const lowEntropy = () => ({ brands: brands.map(item => ({ ...item })), mobile: false, platform: 'Windows' });
    const desktopHints = {
      architecture: 'x86', bitness: '64', model: '', platformVersion: '10.0.0',
      uaFullVersion: version, fullVersionList: [{ brand: 'Chromium', version }],
      wow64: false, formFactors: ['Desktop']
    };
    define(navigator, 'userAgentData', Object.freeze({
      ...lowEntropy(),
      toJSON: lowEntropy,
      async getHighEntropyValues(hints = []) {
        const result = lowEntropy();
        for (const hint of hints) {
          if (Object.hasOwn(desktopHints, hint)) {
            const value = desktopHints[hint];
            result[hint] = Array.isArray(value)
              ? value.map(item => typeof item === 'object' ? { ...item } : item)
              : value;
          }
        }
        return result;
      }
    }));
  }
})();
