import { deflateSync } from "node:zlib";

export interface TestPakFile {
  readonly path: string;
  readonly content: string;
  readonly compress?: boolean;
}

/** Build the minimal PAC1 subset used by VFS-backed integration tests. */
export function buildTestPak(files: readonly TestPakFile[]): Buffer {
  interface TreeFile {
    name: string;
    offset: number;
    compressedLen: number;
    decompressedLen: number;
    compressed: boolean;
  }
  interface TreeDir {
    name: string;
    children: Map<string, TreeDir | TreeFile>;
  }

  const dataChunks: Buffer[] = [];
  const headLength = 0x1c;
  const dataStart = 12 + 8 + headLength + 8;
  let dataOffset = dataStart;
  const root: TreeDir = { name: "", children: new Map() };

  for (const file of files) {
    const raw = Buffer.from(file.content, "utf8");
    const compressed = file.compress === true;
    const stored = compressed ? deflateSync(raw) : raw;
    const segments = file.path.split("/");
    const fileName = segments.pop();
    if (!fileName || segments.some((segment) => !segment)) {
      throw new Error(`Invalid synthetic PAK path: ${file.path}`);
    }

    let directory = root;
    for (const segment of segments) {
      let child = directory.children.get(segment);
      if (!child || !("children" in child)) {
        child = { name: segment, children: new Map() };
        directory.children.set(segment, child);
      }
      directory = child;
    }
    directory.children.set(fileName, {
      name: fileName,
      offset: dataOffset,
      compressedLen: stored.length,
      decompressedLen: raw.length,
      compressed,
    });
    dataChunks.push(stored);
    dataOffset += stored.length;
  }

  const serializeEntry = (entry: TreeDir | TreeFile): Buffer => {
    const name = Buffer.from(entry.name, "utf8");
    const header = Buffer.from(["children" in entry ? 0 : 1, name.length]);
    if ("children" in entry) {
      const count = Buffer.alloc(4);
      count.writeUInt32LE(entry.children.size);
      return Buffer.concat([
        header,
        name,
        count,
        ...Array.from(entry.children.values(), serializeEntry),
      ]);
    }

    const metadata = Buffer.alloc(24);
    metadata.writeUInt32LE(entry.offset, 0);
    metadata.writeUInt32LE(entry.compressedLen, 4);
    metadata.writeUInt32LE(entry.decompressedLen, 8);
    metadata.writeUInt8(entry.compressed ? 1 : 0, 18);
    metadata.writeUInt8(entry.compressed ? 6 : 0, 19);
    return Buffer.concat([header, name, metadata]);
  };

  const data = Buffer.concat(dataChunks);
  const fileTree = serializeEntry(root);
  const totalPayload = 4 + 8 + headLength + 8 + data.length + 8 + fileTree.length;
  const pak = Buffer.alloc(8 + totalPayload);
  let position = 0;
  pak.write("FORM", position, 4, "ascii"); position += 4;
  pak.writeUInt32BE(totalPayload, position); position += 4;
  pak.write("PAC1", position, 4, "ascii"); position += 4;
  pak.write("HEAD", position, 4, "ascii"); position += 4;
  pak.writeUInt32BE(headLength, position); position += 4 + headLength;
  pak.write("DATA", position, 4, "ascii"); position += 4;
  pak.writeUInt32BE(data.length, position); position += 4;
  data.copy(pak, position); position += data.length;
  pak.write("FILE", position, 4, "ascii"); position += 4;
  pak.writeUInt32BE(fileTree.length, position); position += 4;
  fileTree.copy(pak, position);
  return pak;
}
