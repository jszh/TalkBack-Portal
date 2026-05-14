const http = require('http');

/**
 * Single-flight HTTP fetcher for mobilerun-portal endpoints.
 *
 * The recording manager and the screenshot/tree proxy routes both want to pull
 * `/screenshot` and `/a11y_tree_full` on the same 500 ms focus-debounce. Two
 * concurrent requests racing into mobilerun's HTTP server return a 502 from
 * the second one (mobilerun serializes screenshot captures internally). We
 * coalesce so any number of concurrent callers share one upstream request.
 *
 * No caching — only deduplication of in-flight calls.
 */
const inflight = new Map();

function get({ host, port, token, urlPath, key }) {
  const k = key || `${host}:${port}${urlPath}`;
  const existing = inflight.get(k);
  if (existing) return existing;
  const promise = new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port,
        path: urlPath,
        method: 'GET',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            contentType: res.headers['content-type'],
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  }).finally(() => {
    inflight.delete(k);
  });
  inflight.set(k, promise);
  return promise;
}

module.exports = { get };
