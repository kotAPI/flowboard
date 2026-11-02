import { useState } from "react";
import type { Route } from "../route";
import type { TreeNode } from "../types";

const ICON: Record<string, string> = { space: "◆", folder: "▸", list: "≡" };

export function Sidebar({ tree, loading, route, isAdmin }: { tree?: TreeNode; loading: boolean; route: Route; isAdmin: boolean }) {
  const activeId = route.page === "list" ? route.listId : route.page === "config" ? route.nodeId : null;
  return (
    <nav className="sidebar" aria-label="Workspace">
      <div className="sidebar-head">
        <span className="muted small">WORKSPACE</span>
        {isAdmin && tree && (
          <a className="gear" href={`#/config/${tree.id}`} title="Workspace statuses" aria-label="Configure workspace">⚙</a>
        )}
      </div>
      {loading && <p className="muted small">Loading…</p>}
      {tree && tree.children.length === 0 && <p className="muted small">Nothing shared with you yet.</p>}
      <ul className="tree" role="tree">
        {tree?.children.map((n) => <TreeItem key={n.id} node={n} depth={0} activeId={activeId} isAdmin={isAdmin} />)}
      </ul>
    </nav>
  );
}

function TreeItem({ node, depth, activeId, isAdmin }: { node: TreeNode; depth: number; activeId: string | null; isAdmin: boolean }) {
  const [open, setOpen] = useState(true);
  const isList = node.type === "list";
  return (
    <li role="treeitem" aria-expanded={isList ? undefined : open} aria-selected={activeId === node.id}>
      <div className={`tree-row ${activeId === node.id ? "active" : ""}`} style={{ paddingLeft: 8 + depth * 14 }}>
        {!isList ? (
          <button className="twisty" aria-label={open ? `Collapse ${node.name}` : `Expand ${node.name}`} onClick={() => setOpen(!open)}>
            {open ? "▾" : "▸"}
          </button>
        ) : (
          <span className="twisty" />
        )}
        <span className={`node-icon ${node.type}`}>{ICON[node.type]}</span>
        {isList ? (
          <a className="tree-label" href={`#/lists/${node.id}/board`}>{node.name}</a>
        ) : (
          <span className="tree-label">{node.name}</span>
        )}
        {node.visibility === "private" && <span className="lock" title="Private">🔒</span>}
        {isAdmin && (
          <a className="gear" href={`#/config/${node.id}`} aria-label={`Configure ${node.name}`} title="Statuses & fields">⚙</a>
        )}
      </div>
      {!isList && open && node.children.length > 0 && (
        <ul role="group">
          {node.children.map((c) => <TreeItem key={c.id} node={c} depth={depth + 1} activeId={activeId} isAdmin={isAdmin} />)}
        </ul>
      )}
    </li>
  );
}
