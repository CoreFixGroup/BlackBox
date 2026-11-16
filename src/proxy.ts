import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";

import { beginHttpCall, decodeBody, finishHttpCall, type HttpHooks } from "./protocol.js";

export interface RecordingProxy {
  port: number;
  url: string;
  close: () => void;
}

export function startRecordingProxy(hooks: HttpHooks): Promise<RecordingProxy> {
  const sockets = new Set<Duplex>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      let target: URL;
      try {
        target = new URL(req.url ?? "");
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      if (target.protocol !== "http:") {
        res.writeHead(400);
        res.end();
        return;
      }
      const body = Buffer.concat(chunks);
      const call = beginHttpCall(hooks, {
        method: String(req.method ?? "GET").toUpperCase(),
        url: target.href,
        headers: req.headers,
        body: decodeBody(body),
      });
      const upstream = http.request(
        {
          hostname: target.hostname,
          port: target.port,
          path: `${target.pathname}${target.search}`,
          method: req.method,
          headers: { ...req.headers, host: target.host },
        },
        (upstreamResponse) => {
          const responseChunks: Buffer[] = [];
          upstreamResponse.on("data", (chunk: Buffer) => responseChunks.push(Buffer.from(chunk)));
          upstreamResponse.on("end", () => {
            const responseBody = Buffer.concat(responseChunks);
            finishHttpCall(hooks, call, {
              status: upstreamResponse.statusCode ?? 0,
              headers: upstreamResponse.headers,
              body: decodeBody(responseBody),
            });
            res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
            res.end(responseBody);
          });
        },
      );
      upstream.on("error", (error) => {
        hooks.fail(error, call.requestId);
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      upstream.end(body);
    });
  });

  server.on("connect", (req, clientSocket, head) => {
    sockets.add(clientSocket);
    const [host, portText] = String(req.url ?? "").split(":");
    const port = Number(portText);
    if (!host || !Number.isInteger(port) || port <= 0) {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    hooks.record("http.connect", { host, port });
    const upstream = net.connect(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on("error", () => {
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("proxy failed to bind"));
        return;
      }
      resolve({
        port: address.port,
        url: `http://127.0.0.1:${address.port}`,
        close() {
          for (const socket of sockets) socket.destroy();
          server.close();
        },
      });
    });
  });
}
