import http from "node:http";
import https from "node:https";
import net from "node:net";
export function installNetworkGuard(onBlocked) {
    const original = {
        fetch: globalThis.fetch,
        httpRequest: http.request,
        httpsRequest: https.request,
        httpGet: http.get,
        httpsGet: https.get,
        connect: net.connect,
        createConnection: net.createConnection,
    };
    const block = () => {
        onBlocked();
        const error = new Error("replay blocked a network call");
        error.name = "ReplayNetworkBlocked";
        throw error;
    };
    globalThis.fetch = block;
    http.request = block;
    https.request = block;
    http.get = block;
    https.get = block;
    net.connect = block;
    net.createConnection = block;
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
//# sourceMappingURL=network-guard.js.map