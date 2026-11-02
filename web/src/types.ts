// Shared API contracts (mirrors api/src/modules/*). The CLI and any other channel consume the same shapes.
export type NodeType = "workspace" | "space" | "folder" | "list";
export type StatusCategory = "not_started" | "active" | "done" | "closed";
export type FieldType = "text" | "number" | "single_select" | "multi_select" | "date" | "checkbox";
export type Priority = "urgent" | "high" | "normal" | "low" | "none";

export interface User { id: string; name: string; role: "admin" | "member" }

export interface TreeNode {
  id: string;
  type: NodeType;
  name: string;
  visibility: "public" | "private";
  parentId: string | null;
  children: TreeNode[];
}

export interface ResolvedStatus {
  id: string;
  key: string;
  name: string;
  category: StatusCategory;
  color: string;
  position: number;
  ownerType: NodeType;
  ownerId: string;
  originOwnerId: string;
  inherited: boolean;
}

export interface StatusDef {
  id: string;
  ownerId: string;
  key: string;
  name: string | null;
  category: StatusCategory | null;
  color: string | null;
  position: number | null;
  hidden: boolean;
}

export interface FieldOption { id: string; label: string; color?: string }

export interface FieldDef {
  id: string;
  ownerId: string;
  key: string;
  name: string;
  type: FieldType;
  required: boolean;
  options: FieldOption[];
  position: number;
}

export interface ResolvedField extends FieldDef { ownerType: NodeType; inherited: boolean }

export interface Task {
  id: string;
  listId: string;
  title: string;
  description: string | null;
  statusKey: string;
  priority: Priority;
  assigneeIds: string[];
  dueDate: string | null;
  customFields: Record<string, unknown>;
  position: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Board {
  list: { id: string; name: string };
  statuses: ResolvedStatus[];
  fields: ResolvedField[];
  columns: { statusKey: string; taskIds: string[] }[];
  tasks: Task[];
  truncated: boolean;
}

export interface Page<T> { data: T[]; page: { nextCursor: string | null; limit: number } }

export interface Activity { id: number; summary: string; createdAt: string; type: string }

export interface ApiErrorBody { code: string; message: string; details?: { path?: string; message: string; [k: string]: unknown }[] }

export const PRIORITIES: Priority[] = ["urgent", "high", "normal", "low", "none"];
export const CATEGORIES: StatusCategory[] = ["not_started", "active", "done", "closed"];
export const FIELD_TYPES: FieldType[] = ["text", "number", "single_select", "multi_select", "date", "checkbox"];
