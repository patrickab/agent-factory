"""`factory-tui`: a read-only terminal view of the factory. Everything it shows comes from the CLI through client.py."""

from __future__ import annotations

import json
import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, ClassVar

from rich.text import Text
from textual import on, work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.widgets import Footer, Input, Static, Tree
from textual.widgets.tree import TreeNode

from factory_tui.client import Client, FactoryClient, FactoryCliError

REFRESH_SECONDS = 10.0
TIMELINE_ENTRIES = 15
RESTING_STAGES = {"rejected", "waiting_approve", "merged", "blocked", "cancelled"}
STAGE_STYLE = {
    "merged": "green",
    "done": "green",
    "rejected": "red",
    "blocked": "red",
    "failed": "red",
    "waiting_approve": "yellow",
    "waiting_answer": "yellow",
    "cancelled": "dim",
    "pending": "dim",
}


# ---- pure helpers


def short(path: str) -> str:
    home = str(Path.home())
    return "~" + path[len(home) :] if path.startswith(home + "/") else path


def tokens(count: float) -> str:
    return f"{count / 1000:.1f}k" if count >= 1000 else str(int(count))


def cost(usage: dict | None) -> str:
    return f"${usage['cost']:.2f}" if usage else ""


def usage_text(usage: dict | None) -> str:
    if not usage:
        return "none"
    return f"${usage['cost']:.2f} · {tokens(usage['input'])} in · {tokens(usage['output'])} out"


def sum_usage(usages: list[dict | None]) -> dict | None:
    present = [usage for usage in usages if usage]
    if not present:
        return None
    return {key: sum(usage[key] for usage in present) for key in ("input", "output", "cost")}


def sum_counts(waves: list[dict]) -> dict:
    return {key: sum(wave["counts"][key] for wave in waves) for key in ("done", "total")}


def styled(state: str | None) -> Text:
    state = state or "new"
    return Text(state, style=STAGE_STYLE.get(state, "cyan"))


def first_line(text: str, width: int = 160) -> str:
    line = text.strip().splitlines()[0] if text.strip() else ""
    return line if len(line) <= width else line[: width - 1] + "…"


def matches(query: str, *fields: Any) -> bool:
    return query in " ".join(str(value) for value in fields if value).lower()


def guarded(what: str, build: Callable[[], Text]) -> Text:
    """The detail text, or one red error line when the CLI's JSON is not the shape it reads."""
    try:
        return build()
    except (KeyError, TypeError, ValueError, AttributeError, IndexError) as error:
        return Text(f"cannot show this {what}: unexpected JSON ({type(error).__name__}: {error})", style="red")


@dataclass(frozen=True)
class Item:
    """What a tree node stands for. `key` survives a refresh, so the cursor and collapsed nodes do too."""

    kind: str  # repo | group | wave | tasks | task
    key: tuple
    data: Any = None


@dataclass
class Snapshot:
    repos: list[str] = field(default_factory=list)
    waves: list[dict] = field(default_factory=list)
    tasks: list[dict] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


NUMBER = (int, float)
USAGE_SHAPE = {"input": NUMBER, "output": NUMBER, "cost": NUMBER}
COUNTS_SHAPE = {"done": int, "total": int}
WAVE_SHAPE = {
    "id": str, "repo": str, "tag": str, "title": str, "stage": str, "branch": str, "createdAt": str, "tasks": list
}  # fmt: skip
TASK_SHAPE = {"id": str, "repo": str, "title": str, "state": str, "createdAt": str}


def shape_problem(record: Any, shape: dict[str, Any]) -> str | None:
    """The first field of `record` the tree cannot read, else None."""
    if not isinstance(record, dict):
        return "not an object"
    for key, kind in shape.items():
        if not isinstance(record.get(key), kind) or isinstance(record.get(key), bool):
            return f"{key} is not {kind.__name__ if isinstance(kind, type) else 'a number'}"
    return None


def record_problem(name: str, record: Any) -> str | None:
    """Why the tree cannot show this repo, wave or task, else None. The detail pane guards the rest itself."""
    if name == "repos":
        return None if isinstance(record, str) else "not a path"
    if problem := shape_problem(record, WAVE_SHAPE if name == "waves" else TASK_SHAPE):
        return problem
    if name == "waves" and (problem := shape_problem(record.get("counts"), COUNTS_SHAPE)):
        return f"counts: {problem}"
    if record.get("usage") is not None and (problem := shape_problem(record["usage"], USAGE_SHAPE)):
        return f"usage: {problem}"
    return None


def load_snapshot(client: Client) -> Snapshot:
    """One read of the factory. A failing call leaves its part empty and adds an error; `waves.list` missing is no error.
    A record of the wrong shape is left out with an error line naming it."""
    snapshot = Snapshot()
    for name, read in (("repos", client.repos), ("waves", client.waves), ("tasks", client.tasks)):
        try:
            records = read()
        except FactoryCliError as error:
            snapshot.errors.append(f"{name}: {error}")
            continue
        if not isinstance(records, list):
            snapshot.errors.append(f"{name}: not a list")
            continue
        kept = []
        for index, record in enumerate(records):
            problem = record_problem(name, record)
            if problem is None:
                kept.append(record)
            else:
                label = record.get("id") if isinstance(record, dict) and isinstance(record.get("id"), str) else index
                snapshot.errors.append(f"{name}: {label}: {problem}")
        setattr(snapshot, name, kept)
    return snapshot


# ---- the app


class FactoryView(App[None]):
    TITLE = "factory"
    ENABLE_COMMAND_PALETTE = False
    CSS = """
    Screen { layout: vertical; }
    #panes { height: 1fr; }
    #side, #detail { border: round $surface-lighten-2; border-title-color: $text-muted; padding: 0 1; }
    #side:focus-within, #detail:focus { border: round $accent; border-title-color: $accent; }
    #side { width: 45%; min-width: 34; max-width: 80; }
    #detail { width: 1fr; border-subtitle-color: $text-muted; }
    Tree { background: transparent; }
    Tree > .tree--cursor { background: transparent; color: $accent; text-style: bold; }
    Tree > .tree--guides, Tree > .tree--guides-hover, Tree > .tree--guides-selected { color: $surface-lighten-2; }
    #filter { display: none; border: round $accent; height: 3; }
    #filter.-open { display: block; }
    """
    BINDINGS: ClassVar = [
        Binding("q", "quit", "Quit"),
        Binding("slash", "filter", "Filter"),
        Binding("r", "refresh", "Refresh"),
        Binding("escape", "close_filter", "Back", show=False),
        Binding("h,left", "focus_tree", show=False),
        Binding("l,right", "focus_detail", show=False),
        Binding("j", "cursor('down')", show=False),
        Binding("k", "cursor('up')", show=False),
    ]

    def __init__(self, client: Client | None = None, refresh_seconds: float = REFRESH_SECONDS) -> None:
        super().__init__()
        self.client: Client = client or FactoryClient()
        self.refresh_seconds = refresh_seconds
        self.snapshot = Snapshot()
        self.collapsed: set[tuple] = set()
        self.selected: Item | None = None
        self.timeline: list[dict] = []

    def compose(self) -> ComposeResult:
        yield Input(placeholder="filter waves and tasks", id="filter")
        with Horizontal(id="panes"):
            with Vertical(id="side"):
                yield Tree("factory", id="tree")
            with VerticalScroll(id="detail"):
                yield Static("loading…", id="body")
        yield Footer()

    def on_mount(self) -> None:
        self.theme = "ansi-dark"
        self.query_one("#side").border_title = "repositories"
        self.query_one("#detail").border_title = "detail"
        tree = self.query_one(Tree)
        tree.show_root = False
        tree.focus()
        self.action_refresh()
        if self.refresh_seconds > 0:
            self.set_interval(self.refresh_seconds, self.action_refresh)

    # ---- loading

    @work(thread=True, exclusive=True, group="load")
    def load(self) -> None:
        snapshot = load_snapshot(self.client)
        self.call_from_thread(self.apply_snapshot, snapshot)

    def apply_snapshot(self, snapshot: Snapshot) -> None:
        self.snapshot = snapshot
        for error in snapshot.errors:
            self.notify(error, severity="error", timeout=5)
        self.build_tree()

    # ---- the tree

    def filter_query(self) -> str:
        return self.query_one("#filter", Input).value.strip().lower()

    def build_tree(self) -> None:
        tree = self.query_one(Tree)
        keep = self.selected.key if self.selected else None
        query = self.filter_query()
        snapshot = self.snapshot
        repos = list(snapshot.repos)
        for record in (*snapshot.waves, *snapshot.tasks):
            if record.get("repo") and record["repo"] not in repos:
                repos.append(record["repo"])
        tree.clear()
        found: TreeNode | None = None
        for repo in repos:
            waves = [wave for wave in snapshot.waves if wave.get("repo") == repo]
            tasks = [task for task in snapshot.tasks if task.get("repo") == repo and not task.get("wave")]
            if query:
                waves = [w for w in waves if matches(query, w["id"], w["tag"], w["title"], w["stage"], w["branch"])]
                tasks = [
                    t for t in tasks if matches(query, t["id"], t.get("tag"), t["title"], t["state"], t.get("branch"))
                ]
                if not waves and not tasks:
                    continue
            node = self.add_node(tree.root, Item("repo", ("repo", repo), repo), Text(short(repo), style="bold"))
            for added in [node, *self.add_waves(node, repo, waves), *self.add_tasks(node, repo, tasks)]:
                if keep and added.data is not None and added.data.key == keep:
                    found = added
        cursor = found or self.first_leaf(tree.root)
        if cursor is not None:
            self.call_after_refresh(tree.move_cursor, cursor)
            self.show(cursor.data)
        else:
            self.show(None)

    def add_node(self, parent: TreeNode, item: Item, label: Text, leaf: bool = False) -> TreeNode:
        if leaf:
            return parent.add_leaf(label, data=item)
        return parent.add(label, data=item, expand=item.key not in self.collapsed)

    def add_waves(self, parent: TreeNode, repo: str, waves: list[dict]) -> list[TreeNode]:
        """Waves by tag: every proper prefix of a tag is a group (track, milestone) summing the waves below it."""
        groups: dict[str, TreeNode] = {}
        added: list[TreeNode] = []
        for wave in sorted(waves, key=lambda wave: (wave["tag"], wave["createdAt"])):
            segments = wave["tag"].split("/")
            node = parent
            for depth in range(1, len(segments)):
                prefix = "/".join(segments[:depth])
                if prefix not in groups:
                    below = [w for w in waves if w["tag"].startswith(prefix + "/")]
                    label = self.row(
                        segments[depth - 1], sum_counts(below), None, sum_usage([w.get("usage") for w in below])
                    )
                    groups[prefix] = self.add_node(node, Item("group", ("group", repo, prefix), (prefix, below)), label)
                    added.append(groups[prefix])
                node = groups[prefix]
            label = self.row(segments[-1], wave["counts"], wave["stage"], wave.get("usage"), wave["title"])
            if wave.get("interrupted"):
                label.append("  interrupted", style="red")
            added.append(self.add_node(node, Item("wave", ("wave", wave["id"]), wave), label, leaf=True))
        return added

    def add_tasks(self, parent: TreeNode, repo: str, tasks: list[dict]) -> list[TreeNode]:
        if not tasks:
            return []
        group = self.add_node(parent, Item("tasks", ("tasks", repo)), Text(f"tasks  {len(tasks)}", style="dim"))
        added = [group]
        for task in sorted(tasks, key=lambda task: task["createdAt"], reverse=True):
            label = Text.assemble(styled(task["state"]), "  ", task["title"])
            if task.get("interrupted"):
                label.append("  interrupted", style="red")
            added.append(self.add_node(group, Item("task", ("task", task["id"]), task), label, leaf=True))
        return added

    @staticmethod
    def row(name: str, counts: dict, stage: str | None, usage: dict | None, title: str = "") -> Text:
        label = Text.assemble((name, "bold"), "  ", f"{counts['done']}/{counts['total']}")
        if stage:
            label.append("  ").append_text(styled(stage))
        if usage:
            label.append(f"  {cost(usage)}", style="dim")
        if title:
            label.append(f"  {title}", style="dim")
        return label

    @staticmethod
    def first_leaf(root: TreeNode) -> TreeNode | None:
        for child in root.children:
            if child.data and child.data.kind in ("wave", "task"):
                return child
            leaf = FactoryView.first_leaf(child)
            if leaf is not None:
                return leaf
        return root.children[0] if root.children else None

    def node_of(self, key: tuple) -> TreeNode | None:
        def walk(node: TreeNode) -> TreeNode | None:
            for child in node.children:
                if child.data and child.data.key == key:
                    return child
                found = walk(child)
                if found:
                    return found
            return None

        return walk(self.query_one(Tree).root)

    # ---- the detail pane

    def show(self, item: Item | None) -> None:
        self.selected = item
        detail = self.query_one("#detail")
        body = self.query_one("#body", Static)
        detail.border_subtitle = ""
        if item is None:
            detail.border_title = "detail"
            errors = "\n".join(self.snapshot.errors)
            body.update(Text(errors or "no repositories, waves or tasks", style="red" if errors else "dim"))
        elif item.kind == "wave":
            detail.border_title, detail.border_subtitle = f"wave {item.data['tag']}", item.data["id"]
            body.update(guarded("wave", lambda: self.wave_text(item.data)))
        elif item.kind == "task":
            detail.border_title, detail.border_subtitle = "task", item.data["id"]
            self.timeline = []
            body.update(guarded("task", lambda: self.task_text(item.data, None)))
            self.load_timeline(item.data)
        elif item.kind == "group":
            prefix, waves = item.data
            detail.border_title = prefix
            body.update(guarded("group", lambda: self.group_text(waves)))
        elif item.kind == "repo":
            detail.border_title = short(item.data)
            repo_waves = [wave for wave in self.snapshot.waves if wave.get("repo") == item.data]
            body.update(guarded("repository", lambda: self.group_text(repo_waves)))
        else:
            detail.border_title = "tasks"
            body.update(Text("tasks outside a wave", style="dim"))

    @work(thread=True, exclusive=True, group="detail")
    def load_timeline(self, task: dict) -> None:
        try:
            entries: list[dict] | str = self.client.timeline(task["id"])
        except FactoryCliError as error:
            entries = str(error)
        self.call_from_thread(self.show_timeline, task, entries)

    def show_timeline(self, task: dict, entries: list[dict] | str) -> None:
        if not self.selected or self.selected.key != ("task", task["id"]):
            return
        self.timeline = entries if isinstance(entries, list) else []
        self.query_one("#body", Static).update(guarded("task", lambda: self.task_text(task, entries)))

    @staticmethod
    def group_text(waves: list[dict]) -> Text:
        counts = sum_counts(waves)
        text = Text.assemble(("waves  ", "dim"), str(len(waves)), "\n")
        text.append_text(Text.assemble(("tasks  ", "dim"), f"{counts['done']}/{counts['total']} done", "\n"))
        text.append_text(
            Text.assemble(("usage  ", "dim"), usage_text(sum_usage([w.get("usage") for w in waves])), "\n")
        )
        for wave in sorted(waves, key=lambda wave: wave["tag"]):
            line = Text.assemble(
                "\n", (wave["tag"], "bold"), "  ", f"{wave['counts']['done']}/{wave['counts']['total']}  "
            )
            line.append_text(styled(wave["stage"])).append(f"  {wave['title']}", style="dim")
            text.append_text(line)
        return text

    @staticmethod
    def wave_text(wave: dict) -> Text:
        text = Text(wave["title"] + "\n", style="bold")
        stage = styled(wave["stage"])
        if wave.get("reason"):
            stage.append(f" ({wave['reason']})")
        if wave.get("running"):
            stage.append("  running", style="cyan")
        if wave.get("interrupted"):
            stage.append("  interrupted", style="red")
        counts = wave["counts"]
        for name, value in (
            ("stage", stage),
            ("tasks", f"{counts['done']}/{counts['total']} done"),
            ("branch", f"{wave['branch']} → {wave['target']}"),
            ("repo", short(wave["repo"])),
            ("plan", wave.get("plan") or ""),
            ("usage", usage_text(wave.get("usage"))),
        ):
            if value:
                text.append_text(Text.assemble((f"{name:<7}", "dim"), value, "\n"))
        if wave.get("request"):
            text.append("\n" + wave["request"].strip() + "\n", style="italic")
        text.append("\ntasks\n", style="bold")
        if not wave["tasks"]:
            text.append("  none\n", style="dim")
        for task in wave["tasks"]:
            line = Text.assemble("  ", styled(task["state"]), "  ", (task["key"], "bold"), f"  {task['title']}")
            if task.get("usage"):
                line.append(f"  {cost(task['usage'])}", style="dim")
            if task.get("after"):
                line.append(f"  after {', '.join(task['after'])}", style="dim")
            text.append_text(line).append("\n")
        if wave.get("reviews"):
            text.append("\nreviews\n", style="bold")
        for review in wave.get("reviews", []):
            line = Text.assemble(f"  round {review['round']}  ", styled(review["verdict"]))
            line.append(f"  {review.get('model') or ''}  {cost(review.get('usage'))}", style="dim")
            text.append_text(line).append("\n")
            for finding in review.get("findings", []):
                where = finding["file"] + (f":{finding['line']}" if finding.get("line") is not None else "")
                severity = {"blocker": "red", "major": "yellow"}.get(finding["severity"], "dim")
                text.append_text(
                    Text.assemble("    ", (finding["severity"], severity), f"  {where}  ", finding["text"])
                )
                text.append("\n")
        if wave.get("gates"):
            text.append("\ngates\n", style="bold")
        for gate in wave.get("gates", []):
            verdict = Text("passed", style="green") if gate["passed"] else Text("failed", style="red")
            text.append_text(Text.assemble(f"  {gate['phase']}  ", verdict, (f"  {gate['wallMs'] / 1000:.0f}s", "dim")))
            text.append("\n")
        if wave.get("merge"):
            merge = wave["merge"]
            text.append("\nmerge\n", style="bold")
            text.append(f"  {merge['from'][:10]}..{merge['to'][:10]}  {merge['at']}\n")
        remote = wave.get("remote")
        if remote and (remote.get("url") or remote.get("error")):
            text.append("\nremote\n", style="bold")
            text.append(f"  {remote.get('url') or ''}\n")
            if remote.get("error"):
                text.append(f"  {remote['error']}\n", style="red")
        return text

    @staticmethod
    def task_text(task: dict, entries: list[dict] | str | None) -> Text:
        text = Text(task["title"] + "\n", style="bold")
        state = styled(task["state"])
        if task.get("reason"):
            state.append(f" ({task['reason']})")
        if task.get("running"):
            state.append("  running", style="cyan")
        if task.get("interrupted"):
            state.append("  interrupted", style="red")
        for name, value in (
            ("state", state),
            ("round", "" if task.get("round") is None else str(task["round"])),
            ("tag", task.get("tag") or ""),
            ("branch", task.get("branch") or ""),
            ("repo", short(task.get("repo") or "")),
            ("usage", usage_text(task.get("usage"))),
        ):
            if value:
                text.append_text(Text.assemble((f"{name:<7}", "dim"), value, "\n"))
        if task.get("question"):
            text.append(f"\nquestion: {task['question']}\n", style="yellow")
        text.append("\ntimeline\n", style="bold")
        if entries is None:
            text.append("  loading…\n", style="dim")
        elif isinstance(entries, str):
            text.append(f"  {entries}\n", style="red")
        elif not entries:
            text.append("  no entries\n", style="dim")
        else:
            for entry in entries[-TIMELINE_ENTRIES:]:
                data = entry.get("data") or {}
                summary = data["text"] if isinstance(data.get("text"), str) else json.dumps(data, separators=(",", ":"))
                text.append_text(Text.assemble(("  " + (entry.get("at") or "")[11:19], "dim"), f"  {entry['kind']:<8}"))
                text.append(first_line(summary) + "\n")
        return text

    # ---- events

    @on(Tree.NodeHighlighted)
    def node_highlighted(self, event: Tree.NodeHighlighted) -> None:
        if event.node.data and event.node.data != self.selected:
            self.show(event.node.data)

    @on(Tree.NodeCollapsed)
    def node_collapsed(self, event: Tree.NodeCollapsed) -> None:
        if event.node.data:
            self.collapsed.add(event.node.data.key)

    @on(Tree.NodeExpanded)
    def node_expanded(self, event: Tree.NodeExpanded) -> None:
        if event.node.data:
            self.collapsed.discard(event.node.data.key)

    @on(Input.Changed, "#filter")
    def filter_changed(self) -> None:
        self.build_tree()

    @on(Input.Submitted, "#filter")
    def filter_submitted(self) -> None:
        self.query_one(Tree).focus()

    # ---- actions (read only)

    def action_refresh(self) -> None:
        self.load()

    def action_filter(self) -> None:
        box = self.query_one("#filter", Input)
        box.add_class("-open")
        box.focus()

    def action_close_filter(self) -> None:
        box = self.query_one("#filter", Input)
        if box.has_class("-open"):
            box.value = ""
            box.remove_class("-open")
        self.query_one(Tree).focus()

    def action_focus_tree(self) -> None:
        self.query_one(Tree).focus()

    def action_focus_detail(self) -> None:
        self.query_one("#detail").focus()

    def action_cursor(self, direction: str) -> None:
        focused = self.focused
        for name in (f"action_cursor_{direction}", f"action_scroll_{direction}"):
            if focused is not None and hasattr(focused, name):
                getattr(focused, name)()
                return


def main(arguments: list[str] | None = None) -> None:
    arguments = sys.argv[1:] if arguments is None else arguments
    if arguments and arguments[0] in ("-h", "--help"):
        print("usage: factory-tui  (the factory CLI from PATH, or FACTORY_CLI)")
        return
    FactoryView().run()


if __name__ == "__main__":
    main()
