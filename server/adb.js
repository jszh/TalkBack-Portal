const { execFile } = require('child_process');

function execAdb(args, { serial = null, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const full = serial ? ['-s', serial, ...args] : args;
    execFile('adb', full, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

async function getAuthToken({ serial = null } = {}) {
  try {
    const out = await execAdb(
      ['shell', 'content', 'query', '--uri', 'content://com.mobilerun.portal/auth_token'],
      { serial },
    );
    // Output shape: `Row: 0 result={"status":"success","result":"<uuid>"}`
    const jsonStart = out.indexOf('result=');
    if (jsonStart === -1) return null;
    const jsonText = out.slice(jsonStart + 'result='.length).trim();
    try {
      const parsed = JSON.parse(jsonText);
      if (parsed && parsed.status === 'success' && typeof parsed.result === 'string') {
        return parsed.result;
      }
    } catch (_) {
      // Older mobilerun builds may return the raw token after `result=`.
      const fallback = jsonText.match(/^[0-9a-fA-F-]{8,}/);
      if (fallback) return fallback[0];
    }
    return null;
  } catch (e) {
    return null;
  }
}

module.exports = { execAdb, getAuthToken };
