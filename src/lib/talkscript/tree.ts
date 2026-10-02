import type { DraftEvent } from "./types";

export interface TalkTreeNode {
  event: DraftEvent;
  children: TalkTreeNode[];
}

/** The parent-scope (lowercase) `e` tag value — last one wins per NIP-22. */
function parentEventId(event: DraftEvent): string | undefined {
  const eTags = event.tags.filter((tag) => tag[0] === "e" && tag[1]);
  return eTags.at(-1)?.[1];
}

/**
 * Build a display tree from compiled IR events: events[0] is the kind 11
 * root, each later event hangs under the event its parent-scope `e` tag
 * points at. Events whose parent cannot be resolved attach directly under
 * the root so nothing is dropped.
 */
export function buildTalkTree(events: DraftEvent[]): TalkTreeNode | null {
  const [first, ...rest] = events;
  if (!first) return null;

  const root: TalkTreeNode = { event: first, children: [] };
  const byId = new Map<string, TalkTreeNode>([[first.id, root]]);

  for (const event of rest) {
    const node: TalkTreeNode = { event, children: [] };
    const parentId = parentEventId(event);
    const parent = (parentId && byId.get(parentId)) || root;
    parent.children.push(node);
    byId.set(event.id, node);
  }

  return root;
}
