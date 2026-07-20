import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    canonicalizeExistingDirectory,
    canonicalizePotentialPath,
    ManagedPathError,
    resolveManagedPath,
} from "../../src/foundation/managed-path.js";
import { validateProjectPath } from "../../src/utils/safe-path.js";

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    roots.push(root);
    return root;
}

describe("managed path policies", () => {
    it("keeps project paths on an explicit lexical trust boundary", () => {
        const parent = temporaryRoot("foundation-project-path-");
        const project = join(parent, "project");
        const outside = join(parent, "shared-assets");
        mkdirSync(project);
        mkdirSync(outside);
        symlinkSync(outside, join(project, "linked-assets"), "junction");

        const throughLink = join(project, "linked-assets", "texture.edds");
        expect(resolveManagedPath(project, throughLink, "lexical")).toBe(throughLink);
        expect(validateProjectPath(project, "linked-assets/texture.edds")).toBe(throughLink);
    });

    it("rejects the same outside link for private managed storage", () => {
        const parent = temporaryRoot("foundation-private-path-");
        const managed = join(parent, "managed");
        const outside = join(parent, "outside");
        mkdirSync(managed);
        mkdirSync(outside);
        symlinkSync(outside, join(managed, "escape"), "junction");

        expect(() => resolveManagedPath(managed, join(managed, "escape", "record.json"), "link-safe"))
            .toThrow(expect.objectContaining<Partial<ManagedPathError>>({ reason: "link_escape" }));
    });

    it("offers an explicit no-links policy for private root construction", () => {
        const managed = temporaryRoot("foundation-no-links-");
        const actual = join(managed, "actual");
        const linked = join(managed, "linked");
        mkdirSync(actual);
        symlinkSync(actual, linked, "junction");

        expect(resolveManagedPath(managed, join(linked, "record.json"), "link-safe"))
            .toBe(join(linked, "record.json"));
        expect(() => resolveManagedPath(managed, join(linked, "record.json"), "no-links"))
            .toThrow(expect.objectContaining<Partial<ManagedPathError>>({ reason: "link_escape" }));
    });

    it("canonicalizes an existing linked prefix while preserving a missing tail", () => {
        const root = temporaryRoot("foundation-potential-follow-");
        const actual = join(root, "actual");
        const linked = join(root, "linked");
        mkdirSync(actual);
        symlinkSync(actual, linked, "junction");

        const target = join(linked, "future", "records");
        expect(canonicalizePotentialPath(target, {
            linkPolicy: "follow-existing",
            existingAncestor: "any",
        })).toBe(join(canonicalizeExistingDirectory(actual), "future", "records"));
    });

    it("rejects links in the existing prefix of a prospective private root", () => {
        const root = temporaryRoot("foundation-potential-no-links-");
        const actual = join(root, "actual");
        const linked = join(root, "linked");
        mkdirSync(actual);
        symlinkSync(actual, linked, "junction");

        expect(() => canonicalizePotentialPath(join(linked, "future"), {
            linkPolicy: "no-links",
            existingAncestor: "directory",
        })).toThrow(expect.objectContaining<Partial<ManagedPathError>>({ reason: "link_escape" }));
    });

    it("rejects a non-directory ancestor when constructing a prospective directory", () => {
        const root = temporaryRoot("foundation-potential-file-");
        const file = join(root, "occupied");
        writeFileSync(file, "occupied");

        expect(() => canonicalizePotentialPath(join(file, "future"), {
            linkPolicy: "follow-existing",
            existingAncestor: "directory",
        })).toThrow(expect.objectContaining<Partial<ManagedPathError>>({ reason: "root_not_directory" }));
    });

    it("rejects prefix-collision siblings in both modes", () => {
        const parent = temporaryRoot("foundation-prefix-");
        const managed = join(parent, "state");
        const sibling = join(parent, "state-other", "record.json");
        mkdirSync(managed);

        expect(() => resolveManagedPath(managed, sibling, "lexical")).toThrow();
        expect(() => resolveManagedPath(managed, sibling, "link-safe")).toThrow();
        expect(() => resolveManagedPath(managed, sibling, "no-links")).toThrow();
    });
});
