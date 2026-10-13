import { createInterface } from "node:readline";
import { Writable, type Readable } from "node:stream";

export async function readPrompt(input: Readable, output: Writable, label: string, hidden = false): Promise<string> {
  output.write(label);
  const sink = new Writable({ write(chunk, _encoding, callback) { if (!hidden) output.write(chunk); callback(); } });
  const reader = createInterface({ input, output: sink, terminal: true });
  try {
    return await new Promise<string>((resolve, reject) => {
      reader.once("SIGINT", () => { reader.close(); reject(new Error("cancelled")); });
      reader.once("close", () => reject(new Error("closed")));
      reader.question("", resolve);
    });
  } finally { reader.close(); sink.destroy(); if (hidden) output.write("\n"); }
}
