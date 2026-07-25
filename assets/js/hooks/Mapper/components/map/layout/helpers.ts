import { LayoutEdgeInput } from './types';

export interface GraphComponent {
  nodeIds: string[];
  edges: LayoutEdgeInput[];
}

/**
 * Connected components over `nodeIds` using `edges` (edges whose endpoints are not both in
 * `nodeIds` are ignored). Members and components are returned in deterministic sorted order.
 */
export const getConnectedComponents = (nodeIds: string[], edges: LayoutEdgeInput[]): GraphComponent[] => {
  const nodeSet = new Set(nodeIds);
  const adj = new Map<string, Set<string>>();
  nodeIds.forEach(id => adj.set(id, new Set()));

  const relevantEdges = edges.filter(e => nodeSet.has(e.source) && nodeSet.has(e.target));
  relevantEdges.forEach(e => {
    adj.get(e.source)!.add(e.target);
    adj.get(e.target)!.add(e.source);
  });

  const visited = new Set<string>();
  const components: GraphComponent[] = [];

  for (const start of [...nodeIds].sort()) {
    if (visited.has(start)) {
      continue;
    }

    const stack = [start];
    visited.add(start);
    const members = new Set<string>([start]);

    while (stack.length) {
      const cur = stack.pop() as string;
      for (const nb of adj.get(cur) ?? []) {
        if (!visited.has(nb)) {
          visited.add(nb);
          members.add(nb);
          stack.push(nb);
        }
      }
    }

    const compEdges = relevantEdges.filter(e => members.has(e.source) && members.has(e.target));
    components.push({ nodeIds: [...members].sort(), edges: compEdges });
  }

  return components;
};
