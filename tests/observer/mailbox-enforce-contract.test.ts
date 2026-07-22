import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { observerAddonSource } from "../support/observer-fixtures.js";

function enforceMethod(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`Missing Enforce method: ${signature}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unclosed Enforce method: ${signature}`);
}

function expectContains(body: string, ...fragments: string[]): void {
  for (const fragment of fragments) expect(body).toContain(fragment);
}

const source = readFileSync(join(observerAddonSource, "Scripts", "Game", "ReforgerForgeObserver",
  "RFO_ObserverMailboxTransport.c"), "utf8");

describe("observer mailbox Enforce contract", () => {
  it("models locked-file fairness beyond one 256-entry Enforce work batch", () => {
    const poll = enforceMethod(source, "override bool PollCommand()");
    const cap = Number(/MAX_COMMAND_FILES\s*=\s*(\d+)/.exec(source)?.[1]);
    expect(cap).toBe(256);
    expectContains(poll, "inspected < MAX_COMMAND_FILES", "m_RFO_CommandCursor = files[index]",
      "RecordIngressDisposition");
    expectContains(source, "enum RFO_ObserverMailboxDisposition", "RETAINED_FOR_RETRY",
      "STORAGE_UNAVAILABLE");
    expect(poll).not.toContain("m_RFO_Initialized = false");

    // Behavioral model of the source-verified sorted/cursor/capped loop. The controlled V10
    // Workbench gate executes this case against compiled Enforce; this remains supplementary.
    let files = Array.from({ length: 300 }, (_, index) =>
      `${String(index + 1).padStart(12, "0")}-capture-poison-${index + 1}.json`
    );
    const locked = files[0];
    const valid = "000000000301-capture-valid-1.json";
    files.push(valid);
    let cursor = "", accepted = false, lockHeld = true, heartbeatPublications = 0;
    const quarantine: string[] = [];
    const retainEvidence = (name: string) => {
      if (!quarantine.includes(name)) quarantine.push(name);
      while (quarantine.length > 128) quarantine.shift();
    };
    const pollModel = () => {
      const snapshot = [...files].sort();
      const cursorIndex = cursor ? snapshot.indexOf(cursor) : -1;
      const start = cursorIndex >= 0 ? (cursorIndex + 1) % snapshot.length : 0;
      for (let offset = 0; offset < snapshot.length && offset < cap; offset += 1) {
        const name = snapshot[(start + offset) % snapshot.length];
        cursor = name;
        if (name === valid) {
          accepted = true; files = files.filter((candidate) => candidate !== name); return;
        }
        retainEvidence(name);
        if (name === locked && lockHeld) continue;
        files = files.filter((candidate) => candidate !== name);
      }
    };
    pollModel(); heartbeatPublications += 1;
    expect(accepted).toBe(false);
    pollModel(); heartbeatPublications += 1;
    expect(accepted).toBe(true);
    expect(files).toContain(locked);
    expect(quarantine.length).toBeLessThanOrEqual(128);
    expect(new Set(quarantine).size).toBe(quarantine.length);
    expect(heartbeatPublications).toBe(2);

    lockHeld = false; pollModel(); heartbeatPublications += 1;
    expect(files).not.toContain(locked);
    expect(new Set(quarantine).size).toBe(quarantine.length);
    expect(heartbeatPublications).toBe(3);
  });

  it("supplements behavioral coverage with Enforce writer serialization architecture checks", () => {
    const writeOwned = enforceMethod(source, "protected bool WriteOwned(string kind, string data)");
    const reclaim = enforceMethod(source, "protected bool ReclaimOrphanStatusFiles()");

    expect(writeOwned.indexOf("ReclaimOrphanStatusFiles()"))
      .toBeLessThan(writeOwned.indexOf("existingFiles.Count() >= MAX_STATUS_FILES"));
    expectContains(writeOwned, "m_RFO_EgressHealthy = false");
    expectContains(reclaim, "markerNames.Contains(dataName + \".complete\")",
      "temporaryName.EndsWith(\".json.tmp\")");
  });

  it("supplements behavioral coverage with idempotent Enforce quarantine architecture checks", () => {
    const quarantine = enforceMethod(source, "protected RFO_ObserverMailboxDisposition QuarantineCommand(string name, string path, string reason, int length)");
    const trim = enforceMethod(source, "protected RFO_ObserverMailboxDisposition TrimQuarantine(int incomingBytes)");
    const deleteOrAbsent = enforceMethod(source, "protected RFO_ObserverMailboxDisposition DeleteOrAbsent(string path, string name, string directory, string extension)");
    const evidenceName = enforceMethod(source, "protected string NewQuarantineEvidenceName(string name)");
    const evidenceBytes = enforceMethod(source, "protected int QuarantineEvidenceBytes(string name)");

    expectContains(quarantine, "QuarantineEvidenceBytes(name)",
      "RFO_ObserverMailboxDisposition.STORAGE_UNAVAILABLE");
    expectContains(trim, "MAX_QUARANTINE_FILES", "MAX_QUARANTINE_BYTES",
      'FileIO.FindFiles(longNameFiles.Insert, QUARANTINE_DIRECTORY, ".rfoq")');
    expectContains(evidenceName, 'name.Substring(0, name.Length() - 5) + ".rfoq"');
    expectContains(evidenceBytes,
      "candidateName.Length() == name.Length() + 13", "candidateName.Substring(13, name.Length()) == name",
      "if (!evidence)", "if (length <= 0 || length > 65536)",
      "envelope.LoadFromFile(evidencePath)", "return -3",
      "DeleteOrAbsent(evidencePath, candidateName, QUARANTINE_DIRECTORY, extension)",
      "envelope.sourceName != name",
    );
    expect(evidenceBytes).not.toContain("EndsWith(suffix)");
    expectContains(deleteOrAbsent, "if (BaseName(candidatePath) == name)",
      "RFO_ObserverMailboxDisposition.RETAINED_FOR_RETRY");
  });
});
