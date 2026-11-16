import http from "node:http";
import https from "node:https";
import net from "node:net";

export function installNetworkGuard(onBlocked: () => void): () => void {
  const original = {
    fetch: globalThis.fetch,
    httpRequest: http.request,
    httpsRequest: https.request,
    httpGet: http.get,
    httpsGet: https.get,
    connect: net.connect,
    createConnection: net.createConnection,
  };
  const block = (): never => {
    onBlocked();
    const error = new Error("replay blocked a network call");
    error.name = "ReplayNetworkBlocked";
    throw error;
  };
  globalThis.fetch = block as typeof fetch;
  http.request = block as typeof http.request;
  https.request = block as typeof https.request;
  http.get = block as typeof http.get;
  https.get = block as typeof https.get;
  net.connect = block as typeof net.connect;
  net.createConnection = block as typeof net.createConnection;
  return () => {
    globalThis.fetch = original.fetch;
    http.request = original.httpRequest;
    https.request = original.httpsRequest;
    http.get = original.httpGet;
    https.get = original.httpsGet;
    net.connect = original.connect;
    net.createConnection = original.createConnection;
  };
}
