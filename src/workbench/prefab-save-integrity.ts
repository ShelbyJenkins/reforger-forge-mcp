import { parse, type EnfusionNode } from "../formats/enfusion-text.js";

function isAnonymousEmptyBlock(node: EnfusionNode): boolean {
  return node.id === undefined && node.className === undefined &&
    node.inheritance === undefined && node.properties.length === 0 &&
    node.values.length === 0 && node.children.length === 0;
}

/**
 * Find explicit empty nested blocks in an inherited prefab. Workbench's native
 * SaveEntityTemplate serializer has been observed dropping these blocks even
 * when they deliberately override a non-empty collection in an ancestor.
 */
export function findExplicitEmptyPrefabOverrides(source: string): string[] {
  const root = parse(source);
  if (!root.inheritance) return [];

  const components = root.children.find((child) => child.type === "components");
  if (!components) return [];

  const found: string[] = [];
  const visit = (node: EnfusionNode, path: string): void => {
    for (const child of node.children) {
      const childPath = `${path}.${child.type}`;
      if (isAnonymousEmptyBlock(child)) found.push(childPath);
      else visit(child, childPath);
    }
  };

  for (const component of components.children) {
    const identity = component.id
      ? `${component.type}[${component.id}]`
      : component.type;
    visit(component, identity);
  }
  return found.sort((left, right) => left.localeCompare(right));
}
