import http from "node:http";
import { once } from "node:events";

import { isDirectRun } from "../src/direct.js";
import { Blackbox } from "../src/index.js";

export async function runProxyDemo(blackbox: Blackbox): Promise<string> {
  const stub = http.createServer((_req, res) => {
    res.end("local");
  });
  stub.listen(0, "127.0.0.1");
  await once(stub, "listening");
  const address = stub.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const session = blackbox.startSession({
    agent: { id: "proxy-agent", name: "Proxy Agent", version: "0.1.0" },
  });
  try {
    const proxy = await session.openProxy();
    await new Promise<void>((resolve, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port: proxy.port,
          method: "GET",
          path: `http://127.0.0.1:${port}/hello`,
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve());
        },
      );
      request.on("error", reject);
      request.end();
    });
    session.finish();
  } finally {
    stub.close();
  }
  return session.id;
}

if (isDirectRun(import.meta.url)) {
  const directory = ".blackbox";
  const sessionId = await runProxyDemo(Blackbox.open({ directory }));
  process.stdout.write(`Recording ${sessionId}\n`);
  process.stdout.write(`Directory ${directory}\n`);
}
