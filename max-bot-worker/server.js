const http = require("node:http");

const MAX_API = "https://platform-api2.max.ru";
const PORT = Number(process.env.PORT || 8080);

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/health") {
      send(res, 200, JSON.stringify({ ok: true, service: "factor-max-api-proxy" }));
      return;
    }

    if (url.pathname !== "/proxy") {
      send(res, 404, JSON.stringify({ ok: false, error: "not_found" }));
      return;
    }

    const path = url.searchParams.get("path") || "";
    if (!path.startsWith("/") || path.includes("://") || path.includes("\\\")) {
      send(res, 400, JSON.stringify({ ok: false, error: "invalid_path" }));
      return;
    }

    const headers = {};
    const authorization = req.headers.authorization;
    const contentType = req.headers["content-type"];

    if (authorization) headers.Authorization = authorization;
    if (contentType) headers["Content-Type"] = contentType;

    const body = req.method === "GET" || req.method === "HEAD"
      ? undefined
      : await readBody(req);

    const upstream = await fetch(MAX_API + path, {
      method: req.method,
      headers,
      body,
    });

    const responseHeaders = {};
    upstream.headers.forEach((value, key) => {
      if (key.toLowerCase() === "content-type") {
        responseHeaders["content-type"] = value;
      }
    });

    const data = Buffer.from(await upstream.arrayBuffer());

    res.writeHead(upstream.status, responseHeaders);
    res.end(data);
  } catch (error) {
    console.error("MAX proxy error:", error);
    send(
      res,
      502,
      JSON.stringify({
        ok: false,
        error: "max_api_proxy_failed",
        detail: error instanceof Error ? error.message : String(error),
      })
    );
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("MAX API proxy listening on", PORT);
});
