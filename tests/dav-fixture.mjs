export function createDav() {
  const files = new Map();
  const requests = [];
  let failure = null;
  let offline = false;
  async function fetcher(raw, options = {}) {
    const url = String(raw);
    const method = options.method || "GET";
    requests.push({ url, method, body: options.body, headers: options.headers });
    if (offline) throw new TypeError("Network unavailable");
    if (failure) return new Response("", { status: failure });
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (method === "MKCOL") return new Response("", { status: 405 });
    if (method === "PROPFIND") {
      const entries = [...files.keys()].filter(file => file.startsWith(url));
      return new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${entries.map(file =>
        `<d:response><d:href>${new URL(file).pathname}</d:href><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
      ).join("")}</d:multistatus>`, { status: 207, headers: { "Content-Type": "application/xml" } });
    }
    if (method === "GET") return files.has(url) ?
      new Response(files.get(url), { status: 200 }) : new Response("", { status: 404 });
    if (method === "PUT") {
      files.set(url, options.body);
      return new Response("", { status: 201 });
    }
    throw new Error(`Unexpected method ${method}`);
  }
  return {
    files, requests, fetcher,
    setFailure(status) { failure = status; },
    setOffline(value) { offline = value; }
  };
}
