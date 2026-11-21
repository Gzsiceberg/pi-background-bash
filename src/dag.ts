export interface DagItem {
  key: string;
  after?: string[];
}

export interface OrderedDagItem<T extends DagItem> {
  index: number;
  key: string;
  node: T;
  after: string[];
}

export function normalizeAfter(after: readonly string[] | undefined): string[] {
  if (!after?.length) {
    return [];
  }
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of after) {
    const id = raw.trim();
    if (!id) {
      throw new Error("Dependency task ID cannot be empty");
    }
    if (!seen.has(id)) {
      seen.add(id);
      unique.push(id);
    }
  }
  return unique;
}

function indexDagItems<T extends DagItem>(nodes: readonly T[]): Map<string, OrderedDagItem<T>> {
  if (nodes.length === 0) {
    throw new Error("bg_run_dag requires at least one task");
  }
  const byKey = new Map<string, OrderedDagItem<T>>();
  for (const [index, node] of nodes.entries()) {
    const key = node.key.trim();
    if (!key || key.length > 120) {
      throw new Error("Each DAG task needs a key of 1–120 characters");
    }
    if (byKey.has(key)) {
      throw new Error(`Duplicate DAG task key: ${key}`);
    }
    byKey.set(key, { index, key, node, after: normalizeAfter(node.after) });
  }
  return byKey;
}

function buildGraph<T extends DagItem>(
  byKey: Map<string, OrderedDagItem<T>>,
  hasExternalTask: (id: string) => boolean,
) {
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const key of byKey.keys()) {
    inDegree.set(key, 0);
    dependents.set(key, []);
  }
  for (const item of byKey.values()) {
    for (const dep of item.after) {
      if (byKey.has(dep)) {
        inDegree.set(item.key, (inDegree.get(item.key) ?? 0) + 1);
        dependents.get(dep)!.push(item.key);
      } else if (!hasExternalTask(dep)) {
        throw new Error(`Unknown dependency "${dep}" for task "${item.key}"`);
      }
    }
  }
  return { inDegree, dependents };
}

export function orderDagItems<T extends DagItem>(
  nodes: readonly T[],
  hasExternalTask: (id: string) => boolean,
): OrderedDagItem<T>[] {
  const byKey = indexDagItems(nodes);
  const { inDegree, dependents } = buildGraph(byKey, hasExternalTask);
  const ready: string[] = [];
  for (const [key, degree] of inDegree) {
    if (degree === 0) {
      ready.push(key);
    }
  }
  const ordered: OrderedDagItem<T>[] = [];
  for (const key of ready) {
    ordered.push(byKey.get(key)!);
    for (const next of dependents.get(key)!) {
      const remaining = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) {
        ready.push(next);
      }
    }
  }
  if (ordered.length !== byKey.size) {
    const cyclic = [...inDegree.entries()].find(([, degree]) => degree > 0)?.[0];
    throw new Error(`Dependency cycle detected in bg_run_dag involving "${cyclic}"`);
  }
  return ordered;
}
