import readline from "node:readline";
if (process.argv.slice(2).join(" ") !== "app-server --listen stdio://") process.exit(64);
const starts = new Map();
let readResult = {};
let heldRead = null;
let holdRead = false;
const send = message => process.stdout.write(JSON.stringify(message) + "\n");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", line => {
  const m = JSON.parse(line), p = m.params ?? {};
  if (m.method === "initialize") send({ id: m.id, result: { userAgent: "recovery-fixture" } });
  else if (m.method === "turn/start") {
    if (starts.size >= 32) throw new Error("Fixture capacity exceeded");
    starts.set(p.input[0].text, m);
  } else if (m.method === "test/ack") {
    const original = starts.get(p.label);
    send({ id: original.id, ...(p.error ? { error: p.error } : { result: { turn: {
      id: p.turnId, ...(Object.hasOwn(p, "status") ? { status: p.status } : {}),
      ...(Object.hasOwn(p, "threadId") ? { threadId: p.threadId } : {}),
    } } }) });
    send({ id: m.id, result: {} });
  } else if (m.method === "test/notify") {
    send({ method: p.method, params: p.params });
    send({ id: m.id, result: {} });
  } else if (m.method === "test/read-result") {
    readResult = p.result; holdRead = p.hold === true;
    send({ id: m.id, result: {} });
  } else if (m.method === "thread/read") {
    if (holdRead) heldRead = m;
    else send({ id: m.id, result: readResult });
  } else if (m.method === "test/release-read") {
    send({ id: heldRead.id, result: readResult }); heldRead = null; holdRead = false;
    send({ id: m.id, result: {} });
  } else if (m.method === "test/barrier") send({ id: m.id, result: {} });
});
lines.on("close", () => process.exit(0));
