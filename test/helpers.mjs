

/** Build a fetch mock that routes by "METHOD /pathname" and records every call. */
export function recorder(routes) {
  const calls = [];
  const fetchMock = async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    const handler = routes[`${init.method} ${u.pathname}`] ?? routes['*'];
    if (!handler) {
      return new Response('{}', { status: 404 });
    }
    const r = handler({ url: u, init });
    const body = r.body === undefined ? '' : JSON.stringify(r.body);
    return new Response(body, { status: r.status ?? 200, headers: r.headers });
  };
  return { calls, fetchMock };
}
