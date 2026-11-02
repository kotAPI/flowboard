import Button from "@radui/ui/Button";
import Tabs from "@radui/ui/Tabs";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { currentUserId, setCurrentUserId } from "./api";
import { BoardView } from "./components/BoardView";
import { ConfigPanel } from "./components/ConfigPanel";
import { Sidebar } from "./components/Sidebar";
import { TableView } from "./components/TableView";
import { TaskDrawer } from "./components/TaskDrawer";
import { ButtonLink, Picker } from "./components/ui";
import { findNode, useBoard, useMe, useTree, useUsers } from "./hooks";
import { useRoute } from "./route";

export function App() {
  const [route, go] = useRoute();
  const [userId, setUserId] = useState(currentUserId());
  const qc = useQueryClient();
  const users = useUsers();
  const me = useMe();
  const tree = useTree();

  const switchUser = (id: string) => {
    setCurrentUserId(id);
    setUserId(id);
    qc.invalidateQueries();
  };

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/">Flowboard</a>
        <span className="muted">{tree.data?.name}</span>
        <div className="spacer" />
        <div className="user-switch">
          <span className="muted">Acting as</span>
          <Picker
            label="Acting user"
            value={userId}
            onChange={switchUser}
            options={(users.data ?? [{ id: "usr_alice", name: "Alice", role: "admin" }]).map((u) => ({ value: u.id.replace("usr_", ""), label: `${u.name} (${u.role})` }))}
          />
        </div>
      </header>
      <Sidebar tree={tree.data} loading={tree.isLoading} route={route} isAdmin={me.data?.role === "admin"} />
      <main className="main">
        {route.page === "home" && <Home />}
        {route.page === "list" && <ListPage key={`${route.listId}:${userId}`} listId={route.listId} view={route.view} onView={(view) => go({ page: "list", listId: route.listId, view })} isAdmin={me.data?.role === "admin"} />}
        {route.page === "config" && (
          <ConfigPanel key={`${route.nodeId}:${userId}`} nodeId={route.nodeId} node={findNode(tree.data, route.nodeId)} />
        )}
      </main>
    </div>
  );
}

function Home() {
  return (
    <div className="empty">
      <h2>Pick a list</h2>
      <p className="muted">Choose a list in the sidebar to see its board. Switch the acting user at the top right to see permissions change.</p>
    </div>
  );
}

function ListPage({ listId, view, onView, isAdmin }: { listId: string; view: "board" | "table"; onView: (v: "board" | "table") => void; isAdmin: boolean }) {
  const board = useBoard(listId);
  const [openTask, setOpenTask] = useState<string | "new" | null>(null);
  const [newStatus, setNewStatus] = useState<string | undefined>();

  if (board.error) {
    const err = board.error as any;
    return (
      <div className="empty" role="alert">
        <h2>{err.status === 403 ? "No access" : err.status === 404 ? "Not found" : "Couldn't load this list"}</h2>
        <p className="muted">{err.message}</p>
      </div>
    );
  }
  if (!board.data) return <div className="empty muted">Loading…</div>;
  const data = board.data;

  return (
    <div className="list-page">
      <div className="list-header">
        <h1>{data.list.name}</h1>
        <Tabs.Root value={view} onValueChange={(v) => onView(v as "board" | "table")}>
          <Tabs.List aria-label="View">
            <Tabs.Trigger value="board">Board</Tabs.Trigger>
            <Tabs.Trigger value="table">List</Tabs.Trigger>
          </Tabs.List>
        </Tabs.Root>
        <div className="spacer" />
        {isAdmin && <ButtonLink variant="ghost" href={`#/config/${listId}`}>Statuses &amp; fields</ButtonLink>}
        <Button onClick={() => { setNewStatus(undefined); setOpenTask("new"); }}>New task</Button>
      </div>
      {view === "board" ? (
        <BoardView board={data} onOpen={setOpenTask} onAdd={(statusKey) => { setNewStatus(statusKey); setOpenTask("new"); }} />
      ) : (
        <TableView board={data} onOpen={setOpenTask} />
      )}
      {openTask && (
        <TaskDrawer
          key={openTask}
          listId={listId}
          board={data}
          taskId={openTask === "new" ? null : openTask}
          initialStatus={newStatus}
          onClose={() => setOpenTask(null)}
        />
      )}
    </div>
  );
}
