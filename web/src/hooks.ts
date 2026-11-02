import { useQuery } from "@tanstack/react-query";
import { currentUserId, get } from "./api";
import type { Board, TreeNode, User } from "./types";

// Query keys include the acting user so switching users never shows another user's cached data.
export const keys = {
  tree: () => ["tree", currentUserId()] as const,
  board: (listId: string) => ["board", currentUserId(), listId] as const,
  tasks: (listId: string, params: string) => ["tasks", currentUserId(), listId, params] as const,
  task: (id: string) => ["task", currentUserId(), id] as const,
  activity: (id: string) => ["activity", currentUserId(), id] as const,
  config: (nodeId: string, kind: string) => ["config", currentUserId(), nodeId, kind] as const,
};

export const useUsers = () => useQuery({ queryKey: ["users"], queryFn: () => get<User[]>("/v1/users"), staleTime: Infinity });
export const useMe = () => useQuery({ queryKey: ["me", currentUserId()], queryFn: () => get<User>("/v1/me") });
export const useTree = () => useQuery({ queryKey: keys.tree(), queryFn: () => get<TreeNode>("/v1/tree") });
export const useBoard = (listId: string) => useQuery({ queryKey: keys.board(listId), queryFn: () => get<Board>(`/v1/lists/${listId}/board`) });

export function findNode(root: TreeNode | undefined, id: string): { node: TreeNode; path: TreeNode[] } | null {
  if (!root) return null;
  if (root.id === id) return { node: root, path: [root] };
  for (const child of root.children) {
    const hit = findNode(child, id);
    if (hit) return { node: hit.node, path: [root, ...hit.path] };
  }
  return null;
}

export function initials(name: string) {
  return name.split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();
}
