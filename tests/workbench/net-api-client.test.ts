import { once } from "node:events";
import { createServer, Socket, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorkbenchNetApiClient,
  WorkbenchNetApiError,
} from "../../src/workbench/net-api-client.js";
import {
  decodeInt32LE,
  decodePascalString,
  encodePascalString,
} from "../../src/workbench/protocol.js";

interface TestServer {
  readonly server: Server;
  readonly port: number;
  close(): Promise<void>;
}

interface DecodedRequest {
  readonly protocolVersion: number;
  readonly clientId: string;
  readonly contentType: string;
  readonly payload: Record<string, unknown>;
}

const openServers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((fixture) => fixture.close()));
});

async function startServer(onConnection: (socket: Socket) => void): Promise<TestServer> {
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    onConnection(socket);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test server did not receive a TCP port.");
  }

  let closed = false;
  const fixture: TestServer = {
    server,
    port: address.port,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => error ? reject(error) : resolvePromise());
      });
    },
  };
  openServers.push(fixture);
  return fixture;
}

function respondAfterRequest(
  socket: Socket,
  response: Buffer | ((request: Buffer) => Buffer)
): void {
  const chunks: Buffer[] = [];
  socket.on("data", (chunk) => chunks.push(chunk));
  socket.once("end", () => {
    const request = Buffer.concat(chunks);
    socket.end(typeof response === "function" ? response(request) : response);
  });
}

function okResponse(payload: unknown): Buffer {
  return Buffer.concat([
    encodePascalString("Ok"),
    encodePascalString(JSON.stringify(payload)),
  ]);
}

function decodeRequest(request: Buffer): DecodedRequest {
  let offset = 0;
  const protocol = decodeInt32LE(request, offset);
  offset += protocol.bytesRead;
  const clientId = decodePascalString(request, offset);
  offset += clientId.bytesRead;
  const contentType = decodePascalString(request, offset);
  offset += contentType.bytesRead;
  const payload = decodePascalString(request, offset);
  offset += payload.bytesRead;
  if (offset !== request.length) throw new Error("Request contained trailing bytes.");
  return {
    protocolVersion: protocol.value,
    clientId: clientId.value,
    contentType: contentType.value,
    payload: JSON.parse(payload.value) as Record<string, unknown>,
  };
}

async function expectTransportError(
  promise: Promise<unknown>,
  code: WorkbenchNetApiError["code"]
): Promise<WorkbenchNetApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(WorkbenchNetApiError);
    expect((error as WorkbenchNetApiError).code).toBe(code);
    return error as WorkbenchNetApiError;
  }
  throw new Error(`Expected Workbench NET API error ${code}.`);
}

describe("WorkbenchNetApiClient", () => {
  it("uses the configured client ID, encodes params, and decodes a chunked success", async () => {
    let decodedRequest: DecodedRequest | undefined;
    const response = okResponse({ status: "ok", count: 3 });
    const fixture = await startServer((socket) => {
      respondAfterRequest(socket, (request) => {
        decodedRequest = decodeRequest(request);
        socket.write(response.subarray(0, 5));
        return response.subarray(5);
      });
    });
    let observedSocket: Socket | undefined;
    const client = new WorkbenchNetApiClient(
      "127.0.0.1",
      fixture.port,
      { clientId: "Stage3Transport" },
      { socketFactory: () => (observedSocket = new Socket()) }
    );

    const result = await client.call<{ status: string; count: number }>(
      "EMCP_WB_ListEntities",
      { offset: 2, limit: 3 }
    );

    expect(result).toEqual({ status: "ok", count: 3 });
    expect(decodedRequest).toEqual({
      protocolVersion: 1,
      clientId: "Stage3Transport",
      contentType: "JsonRPC",
      payload: { offset: 2, limit: 3, APIFunc: "EMCP_WB_ListEntities" },
    });
    expect(observedSocket?.eventNames()).toEqual([]);
  });

  it("classifies a refused endpoint separately", async () => {
    const fixture = await startServer(() => undefined);
    const port = fixture.port;
    await fixture.close();
    const client = new WorkbenchNetApiClient("127.0.0.1", port, {
      defaultTimeoutMs: 1_000,
    });

    const error = await expectTransportError(
      client.call("EMCP_WB_Ping"),
      "connection_refused"
    );

    expect(error.message).toContain(`127.0.0.1:${port}`);
  });

  it("rejects an empty response as a protocol failure", async () => {
    const fixture = await startServer((socket) => respondAfterRequest(socket, Buffer.alloc(0)));
    const client = new WorkbenchNetApiClient("127.0.0.1", fixture.port);

    const error = await expectTransportError(client.call("EmptyResponse"), "protocol");

    expect(error.message).toMatch(/empty response/i);
  });

  it("rejects a truncated status as a protocol failure", async () => {
    const truncated = Buffer.alloc(6);
    truncated.writeInt32LE(8, 0);
    truncated.write("Ok", 4);
    const fixture = await startServer((socket) => respondAfterRequest(socket, truncated));
    const client = new WorkbenchNetApiClient("127.0.0.1", fixture.port);

    const error = await expectTransportError(client.call("TruncatedStatus"), "protocol");

    expect(error.message).toMatch(/malformed status/i);
  });

  it("rejects a truncated payload as a protocol failure", async () => {
    const payloadPrefix = Buffer.alloc(4);
    payloadPrefix.writeInt32LE(20, 0);
    const truncated = Buffer.concat([
      encodePascalString("Ok"),
      payloadPrefix,
      Buffer.from("{}"),
    ]);
    const fixture = await startServer((socket) => respondAfterRequest(socket, truncated));
    const client = new WorkbenchNetApiClient("127.0.0.1", fixture.port);

    const error = await expectTransportError(client.call("TruncatedPayload"), "protocol");

    expect(error.message).toMatch(/malformed payload/i);
  });

  it("rejects an Ok response with no payload or an empty payload as protocol failures", async () => {
    const responses = [
      encodePascalString("Ok"),
      Buffer.concat([encodePascalString("Ok"), encodePascalString("")]),
    ];

    for (const response of responses) {
      const fixture = await startServer((socket) => respondAfterRequest(socket, response));
      const client = new WorkbenchNetApiClient("127.0.0.1", fixture.port);
      await expectTransportError(client.call("MissingPayload"), "protocol");
      await fixture.close();
    }
  });

  it("rejects malformed JSON as a protocol failure without echoing the payload", async () => {
    const sensitiveMalformedPayload = "{not-json:owner-secret}";
    const response = Buffer.concat([
      encodePascalString("Ok"),
      encodePascalString(sensitiveMalformedPayload),
    ]);
    const fixture = await startServer((socket) => respondAfterRequest(socket, response));
    const client = new WorkbenchNetApiClient("127.0.0.1", fixture.port);

    const error = await expectTransportError(client.call("MalformedJson"), "protocol");

    expect(error.message).toMatch(/malformed JSON/i);
    expect(error.message).not.toContain(sensitiveMalformedPayload);
  });

  it("classifies a non-Ok Workbench status as an API error and redacts owner tokens", async () => {
    const ownerToken = "private-owner-token-123";
    const response = encodePascalString(`Undefined API func (${ownerToken})`);
    let decodedRequest: DecodedRequest | undefined;
    const fixture = await startServer((socket) => respondAfterRequest(socket, (request) => {
      decodedRequest = decodeRequest(request);
      return response;
    }));
    const client = new WorkbenchNetApiClient("127.0.0.1", fixture.port);

    const error = await expectTransportError(
      client.call("MissingHandler", { ownerToken }),
      "api_error"
    );

    expect(error.message).toContain("Undefined API func");
    expect(error.message).toContain("[redacted]");
    expect(error.message).not.toContain(ownerToken);
    expect(decodedRequest?.payload.ownerToken).toBe(ownerToken);
  });

  it("rejects trailing response bytes as a protocol failure", async () => {
    const response = Buffer.concat([okResponse({ status: "ok" }), Buffer.from([0xff])]);
    const fixture = await startServer((socket) => respondAfterRequest(socket, response));
    const client = new WorkbenchNetApiClient("127.0.0.1", fixture.port);

    const error = await expectTransportError(client.call("TrailingBytes"), "protocol");

    expect(error.message).toMatch(/trailing bytes/i);
  });

  it("enforces the configured response cap across chunks", async () => {
    const response = okResponse({ value: "x".repeat(128) });
    const fixture = await startServer((socket) => {
      respondAfterRequest(socket, () => {
        socket.write(response.subarray(0, 40));
        return response.subarray(40);
      });
    });
    const client = new WorkbenchNetApiClient("127.0.0.1", fixture.port, {
      responseCapBytes: 48,
    });

    const error = await expectTransportError(client.call("Oversize"), "protocol");

    expect(error.message).toContain("48 bytes");
  });

  it("allows a narrower per-call response cap", async () => {
    const response = okResponse({ value: "x".repeat(64) });
    const fixture = await startServer((socket) => respondAfterRequest(socket, response));
    const client = new WorkbenchNetApiClient("127.0.0.1", fixture.port, {
      responseCapBytes: 1_024,
    });

    await expectTransportError(
      client.call("NarrowPing", {}, { responseCapBytes: 32 }),
      "protocol"
    );
  });

  it("times out, destroys the socket, and removes listeners", async () => {
    const fixture = await startServer((socket) => {
      socket.on("data", () => undefined);
      socket.on("end", () => undefined);
    });
    let observedSocket: Socket | undefined;
    const client = new WorkbenchNetApiClient(
      "127.0.0.1",
      fixture.port,
      { defaultTimeoutMs: 75 },
      { socketFactory: () => (observedSocket = new Socket()) }
    );

    const error = await expectTransportError(client.call("SlowCall"), "timeout");

    expect(error.message).toContain("75ms");
    expect(observedSocket?.destroyed).toBe(true);
    expect(observedSocket?.eventNames()).toEqual([]);
  });

  it("settles once when a normal response emits end followed by close", async () => {
    const fixture = await startServer((socket) => {
      respondAfterRequest(socket, okResponse({ status: "ok" }));
    });
    const client = new WorkbenchNetApiClient("127.0.0.1", fixture.port);
    let settlements = 0;

    const result = await client.call<{ status: string }>("EndThenClose").then(
      (value) => {
        settlements += 1;
        return value;
      },
      (error: unknown) => {
        settlements += 1;
        throw error;
      }
    );
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));

    expect(result.status).toBe("ok");
    expect(settlements).toBe(1);
  });
});
