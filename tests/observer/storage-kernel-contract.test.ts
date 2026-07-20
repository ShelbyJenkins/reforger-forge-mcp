import { atomicWriteFile as foundationAtomicWriteFile } from "../../src/foundation/json-store.js";
import { atomicWriteFile as observerAtomicWriteFile } from "../../observer/agent/paths.js";
import { atomicWriteAdapterContract } from "../foundation/json-store-contract.js";

// The migrated observer stores call BoundedJsonStore directly; their schema,
// retention, and error-translation behavior stays in the existing domain
// suites. The observer paths API is the one remaining adapter seam and must
// satisfy the same publication contract as the foundation implementation.
atomicWriteAdapterContract("foundation writer control", (root, targetPath, data) => {
  foundationAtomicWriteFile({ root, targetPath, data, maxBytes: 1_024 });
});

atomicWriteAdapterContract("observer paths adapter", (root, targetPath, data) => {
  observerAtomicWriteFile(root, targetPath, data);
});
