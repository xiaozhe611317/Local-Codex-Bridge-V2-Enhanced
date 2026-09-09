import readline from "node:readline";
if (process.argv.slice(2).join(" ") !== "app-server --listen stdio://") process.exit(64);
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let initialized = false;
function send(message) { process.stdout.write(JSON.stringify(message) + "\n"); }
lines.on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (process.env.BRIDGE_TEST_BAD_INIT === "1") send({ id: message.id, error: { message: "synthetic initialize failure" } });
    else send({ id: message.id, result: { userAgent: "fake-runtime" } });
  } else if (message.method === "initialized") initialized = true;
  else if (message.method === "test/handshake") send({ id: message.id, result: { initialized, pid: process.pid } });
  else if (message.method === "test/exit") process.exit(23);
  else if (message.method === "test/malformed") process.stdout.write("malformed fixture JSONL" + String.fromCharCode(10));
  else if (message.method === "test/rpc-error") send({ id: message.id, error: { code: -32603, message: "synthetic native error" } });
  else if (message.method === "turn/steer") {
    send({ method: "item/commandExecution/outputDelta", params: {
      threadId: message.params.threadId, turnId: message.params.expectedTurnId, itemId: "cmd", delta: "new fixture output",
    } });
    const text = message.params.input?.[0]?.text;
    const ack = () => {
      if (text === "delayed malformed error") send({ id: message.id, error: { message: "synthetic incomplete error" } });
      else send({ id: message.id, result: text === "delayed missing scope" ? {}
        : { turnId: text === "delayed wrong scope" ? "different-turn" : message.params.expectedTurnId } });
    };
    if (typeof text === "string" && text.startsWith("delayed ")) setTimeout(ack, 250);
    else ack();
  }
  else if (message.method === "test/delay") setTimeout(() => send({ id: message.id, result: {} }), 50);
  else if (message.method === "test/pending") {
    send({ id: 0, method: "item/tool/requestUserInput", params: { threadId: "thread", questions: [] } });
    send({ id: message.id, result: {} });
  }
  // turn/start intentionally receives no response to exercise UNKNOWN.
});
lines.on("close", () => process.exit(0));
