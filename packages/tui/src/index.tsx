import { render } from "@opentui/solid";
import { createSignal, createEffect, onCleanup, onMount, batch, For, Show, createMemo, createSelector, type Accessor } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { useKeyboard, useRenderer } from "@opentui/solid";
import { TextAttributes } from "@opentui/core";

import { ensureServer } from "@opensessions/core";
import {
  type ServerMessage,
  type SessionData,
  type ClientCommand,
  C,
  STATUS_COLORS,
  SERVER_PORT,
  SERVER_HOST,
} from "@opensessions/core";

const SPINNERS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const UNSEEN_ICON = "◆";
const BOLD = TextAttributes.BOLD;
const DIM = TextAttributes.DIM;

function getClientTty(): string {
  try {
    const result = Bun.spawnSync(["tmux", "display-message", "-p", "#{client_tty}"], {
      stdout: "pipe", stderr: "pipe",
    });
    return result.stdout.toString().trim();
  } catch { return ""; }
}

function App() {
  const renderer = useRenderer();

  const [sessions, setSessions] = createStore<SessionData[]>([]);
  const [focusedSession, setFocusedSession] = createSignal<string | null>(null);
  const [currentSession, setCurrentSession] = createSignal<string | null>(null);
  const [connected, setConnected] = createSignal(false);
  const [spinIdx, setSpinIdx] = createSignal(0);

  const clientTty = getClientTty();
  let ws: WebSocket | null = null;

  function send(cmd: ClientCommand) {
    if (connected() && ws) ws.send(JSON.stringify(cmd));
  }

  function switchToSession(name: string) {
    Bun.spawn(
      clientTty
        ? ["tmux", "switch-client", "-c", clientTty, "-t", name]
        : ["tmux", "switch-client", "-t", name],
      { stdout: "ignore", stderr: "ignore" },
    );
  }

  function moveLocalFocus(delta: -1 | 1) {
    const list = sessions;
    if (list.length === 0) return;

    const current = focusedSession();
    const currentIdx = Math.max(0, list.findIndex((s) => s.name === current));
    const nextIdx = Math.max(0, Math.min(list.length - 1, currentIdx + delta));
    const next = list[nextIdx]?.name ?? null;

    if (!next || next === current) return;

    setFocusedSession(next);
    send({ type: "focus-session", name: next });
    send({ type: "mark-seen", name: next });
  }

  onMount(() => {
    const socket = new WebSocket(`ws://${SERVER_HOST}:${SERVER_PORT}`);
    ws = socket;

    socket.onopen = () => {
      setConnected(true);
      if (clientTty) send({ type: "identify", clientTty });
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as ServerMessage;
        batch(() => {
          if (msg.type === "state") {
            setSessions(reconcile(msg.sessions, { key: "name" }));
            setFocusedSession(msg.focusedSession);
            setCurrentSession(msg.currentSession);
          } else if (msg.type === "focus") {
            setFocusedSession(msg.focusedSession);
            setCurrentSession(msg.currentSession);
          }
        });
      } catch {}
    };

    socket.onclose = () => {
      setConnected(false);
      renderer.destroy();
    };

    onCleanup(() => socket.close());
  });

  const hasRunning = createMemo(() =>
    sessions.some((s) => s.agentState?.status === "running"),
  );

  createEffect(() => {
    if (!hasRunning()) return;
    const interval = setInterval(() => {
      setSpinIdx((i) => (i + 1) % SPINNERS.length);
    }, 120);
    onCleanup(() => clearInterval(interval));
  });

  useKeyboard((key) => {
    switch (key.name) {
      case "q":
      case "escape":
        if (ws) ws.close();
        renderer.destroy();
        break;
      case "up":
      case "k":
        moveLocalFocus(-1);
        break;
      case "down":
      case "j":
        moveLocalFocus(1);
        break;
      case "return": {
        const focused = focusedSession();
        if (focused) switchToSession(focused);
        break;
      }
      case "tab": {
        const list = sessions;
        if (list.length === 0) break;
        const cur = currentSession();
        const idx = list.findIndex((s) => s.name === cur);
        const next = list[(idx + (key.shift ? list.length - 1 : 1)) % list.length];
        if (next) switchToSession(next.name);
        break;
      }
      case "r":
        send({ type: "refresh" });
        break;
      default: {
        if (key.number) {
          const idx = parseInt(key.name, 10) - 1;
          const target = sessions[idx];
          if (target) switchToSession(target.name);
        }
        break;
      }
    }
  });

  const runningCount = createMemo(() =>
    sessions.filter((s) => s.agentState?.status === "running").length,
  );

  const unseenCount = createMemo(() =>
    sessions.filter((s) => s.unseen).length,
  );

  const isFocused = createSelector(focusedSession);

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={C.crust}>
      {/* Header */}
      <box flexDirection="column" paddingLeft={2} paddingTop={1} flexShrink={0}>
        <text>
          <span style={{ fg: C.blue, attributes: BOLD }}>⚡ Sessions</span>
          {"  "}
          <span style={{ fg: runningCount() > 0 ? C.text : C.overlay0 }}>{String(sessions.length)}</span>
          {runningCount() > 0 ? " " : ""}
          {runningCount() > 0 ? <span style={{ fg: C.yellow }}>{"⚡"}{runningCount()}</span> : ""}
          {unseenCount() > 0 ? " " : ""}
          {unseenCount() > 0 ? <span style={{ fg: C.teal }}>{"◆"}{unseenCount()}</span> : ""}
        </text>
        <text style={{ fg: C.surface2 }}>{"─".repeat(22)}</text>
      </box>

      {/* Session list */}
      <scrollbox flexGrow={1}>
        <For each={sessions}>
          {(session, i) => (
            <SessionCard
              session={session}
              index={i() + 1}
              isFocused={isFocused(session.name)}
              isCurrent={session.name === currentSession()}
              spinIdx={spinIdx}
              onSelect={() => {
                setFocusedSession(session.name);
                send({ type: "focus-session", name: session.name });
                switchToSession(session.name);
              }}
            />
          )}
        </For>
      </scrollbox>

      {/* Footer */}
      <box flexDirection="column" paddingLeft={2} paddingBottom={1} flexShrink={0}>
        <text style={{ fg: C.surface2 }}>{"─".repeat(22)}</text>
        <text>
          <span style={{ fg: C.overlay0, attributes: DIM }}>⇥</span>
          {" "}
          <span style={{ fg: C.overlay1 }}>cycle</span>
          {"  "}
          <span style={{ fg: C.overlay0, attributes: DIM }}>1-9</span>
          {" "}
          <span style={{ fg: C.overlay1 }}>jump</span>
          {"  "}
          <span style={{ fg: C.overlay0, attributes: DIM }}>⏎</span>
          {" "}
          <span style={{ fg: C.overlay1 }}>go</span>
          {"  "}
          <span style={{ fg: C.overlay0, attributes: DIM }}>q</span>
          {" "}
          <span style={{ fg: C.overlay1 }}>quit</span>
        </text>
      </box>
    </box>
  );
}

// --- Session Card ---

interface SessionCardProps {
  session: SessionData;
  index: number;
  isFocused: boolean;
  isCurrent: boolean;
  spinIdx: Accessor<number>;
  onSelect: () => void;
}

function SessionCard(props: SessionCardProps) {
  const status = () => props.session.agentState?.status ?? "idle";
  const unseen = () => props.session.unseen;

  const isUnseenTerminal = () =>
    unseen() && ["done", "error", "interrupted"].includes(status());

  const accentColor = () => {
    if (isUnseenTerminal()) return unseenAccentColor();
    const s = status();
    if (s === "running") return C.yellow;
    if (props.isCurrent) return C.green;
    if (props.isFocused) return C.blue;
    return C.crust;
  };

  const unseenAccentColor = () => {
    const s = status();
    if (s === "error") return C.red;
    if (s === "interrupted") return C.peach;
    return C.teal;
  };

  const statusIcon = () => {
    if (isUnseenTerminal()) return UNSEEN_ICON;
    const s = status();
    if (s === "running") return SPINNERS[props.spinIdx() % SPINNERS.length]!;
    return "";
  };

  const statusColor = () => {
    if (isUnseenTerminal()) return unseenAccentColor();
    const s = status();
    if (s === "running") return STATUS_COLORS[s];
    return "";
  };

  const nameColor = () =>
    props.isFocused ? C.text : props.isCurrent ? C.subtext1 : C.subtext0;

  const truncName = () => {
    const n = props.session.name;
    return n.length > 20 ? n.slice(0, 19) + "…" : n;
  };

  const truncBranch = () => {
    const b = props.session.branch;
    if (!b) return "";
    return b.length > 17 ? b.slice(0, 16) + "…" : b;
  };

  return (
    <box flexDirection="column">
      <box
        flexDirection="row"
        flexShrink={0}
        backgroundColor={props.isFocused ? C.surface0 : "transparent"}
        paddingTop={1}
        paddingBottom={1}
        onMouseDown={props.onSelect}
      >
        {/* Left accent bar */}
        <text style={{ fg: accentColor() }}>▎</text>

        {/* Index column */}
        <box width={2} flexShrink={0}>
          <text style={{ fg: props.isFocused ? C.overlay1 : C.surface2, attributes: DIM }}>{props.index}</text>
        </box>

        {/* Content column */}
        <box flexDirection="column" flexGrow={1} paddingRight={1}>
          {/* Row 1: name + spinner */}
          <box flexDirection="row">
            <text truncate flexGrow={1}>
              {props.isFocused || props.isCurrent
                ? <span style={{ fg: nameColor(), attributes: BOLD }}>{truncName()}</span>
                : <span style={{ fg: nameColor() }}>{truncName()}</span>}
            </text>
            <Show when={statusIcon()}>
              <text flexShrink={0}><span style={{ fg: statusColor() }}>{statusIcon()}</span></text>
            </Show>
          </box>

          {/* Row 2: branch */}
          <Show when={props.session.branch}>
            <text truncate>
              <span style={{ fg: C.pink }}>{truncBranch()}</span>
            </text>
          </Show>
        </box>
      </box>
    </box>
  );
}

async function main() {
  await ensureServer();
  render(() => <App />, {
    exitOnCtrlC: true,
    targetFPS: 30,
    useMouse: true,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
