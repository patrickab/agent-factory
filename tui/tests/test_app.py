from textual.widgets import Tree

from factory_tui.app import FactoryView
from factory_tui.client import FactoryCliError


def usage(cost, tokens=1000):
    return {"input": tokens, "output": tokens // 2, "cost": cost}


def wave(id, tag, done, total, stage="building", cost=1.0, **extra):
    return {
        "id": id,
        "repo": "/repo",
        "tag": tag,
        "plan": None,
        "title": f"title {id}",
        "request": "review it",
        "branch": f"central-{tag.replace('/', '-')}",
        "target": "central",
        "base": "abc",
        "origin": None,
        "createdAt": f"2025-01-0{len(id)}T00:00:00Z",
        "stage": stage,
        "reason": None,
        "running": False,
        "interrupted": False,
        "tasks": [
            {
                "key": "a",
                "title": "task a",
                "after": [],
                "taskId": "t-a",
                "sessionId": None,
                "state": "done",
                "usage": None,
            }
        ],
        "counts": {"done": done, "total": total},
        "reviews": [],
        "gates": [],
        "merge": None,
        "remote": None,
        "usage": usage(cost),
        "actions": [],
        **extra,
    }


def task(id, title, state="running", wave=None):
    return {
        "id": id,
        "repo": "/repo",
        "worktree": "/wt",
        "branch": f"b-{id}",
        "title": title,
        "createdAt": "2025-01-01T00:00:00Z",
        "tag": "user",
        "plan": None,
        "kind": "task",
        "sessionId": "s",
        "sessionPath": None,
        "state": state,
        "round": 2,
        "reason": None,
        "at": None,
        "question": None,
        "running": True,
        "interrupted": False,
        "settings": None,
        "usage": usage(0.5),
        "actions": [],
        "wave": wave,
    }


REVIEW = {
    "round": 1,
    "at": "2025-01-02T00:00:00Z",
    "sessionId": None,
    "model": "m",
    "verdict": "rejected",
    "status": "ok",
    "findings": [{"severity": "blocker", "file": "src/x.ts", "line": 12, "text": "leaks the lock"}],
    "usage": usage(0.25),
    "wallMs": 1000,
}

WAVES = [
    wave("w1", "factory/m1/w1", 3, 4, cost=1.0),
    wave("w22", "factory/m1/w2", 2, 2, stage="rejected", cost=2.5, reviews=[REVIEW]),
    wave("w333", "tui/w1", 0, 1, cost=0.25),
]
TASKS = [task("t-loose", "a loose task"), task("t-a", "task a", "done", wave="w1")]


class FakeClient:
    def __init__(self, waves=WAVES, tasks=TASKS, waves_error=None):
        self._waves, self._tasks, self.waves_error = waves, tasks, waves_error
        self.calls = []

    def repos(self):
        self.calls.append("repos.list")
        return ["/repo"]

    def waves(self):
        self.calls.append("waves.list")
        if self.waves_error:
            raise self.waves_error
        return self._waves

    def tasks(self):
        self.calls.append("tasks.list")
        return self._tasks

    def timeline(self, task_id):
        self.calls.append(f"tasks.timeline {task_id}")
        return [{"at": "2025-01-01T10:11:12Z", "kind": "coder", "data": {"text": f"entry {n}"}} for n in range(30)]


def labels(app):
    rows = []

    def walk(node, depth):
        for child in node.children:
            rows.append(("  " * depth) + child.label.plain)
            walk(child, depth + 1)

    walk(app.query_one("Tree").root, 0)
    return rows


def selected(app):
    assert app.selected is not None
    return app.selected


def focused_id(app):
    assert app.focused is not None
    return app.focused.id


def body(app):
    return str(app.query_one("#body").render())


async def started(app, pilot):
    await app.workers.wait_for_complete()
    await pilot.pause()


async def test_tree_from_waves_and_tasks_with_sums():
    app = FactoryView(FakeClient(), refresh_seconds=0)
    async with app.run_test(size=(140, 40)) as pilot:
        await started(app, pilot)
        rows = labels(app)
        assert rows[0] == "/repo"
        assert rows[1] == "  factory  5/6  $3.50"  # track: both waves of m1
        assert rows[2] == "    m1  5/6  $3.50"
        assert rows[3].startswith("      w1  3/4  building  $1.00")
        assert rows[4].startswith("      w2  2/2  rejected  $2.50")
        assert rows[5] == "  tui  0/1  $0.25"
        assert rows[6].startswith("    w1  0/1  building")
        assert rows[7] == "  tasks  1"  # the task of wave w1 is not listed
        assert rows[8] == "    running  a loose task"
        assert len(rows) == 9


async def test_detail_of_wave_and_task_and_keys():
    app = FactoryView(FakeClient(), refresh_seconds=0)
    async with app.run_test(size=(140, 40)) as pilot:
        await started(app, pilot)
        assert selected(app).key == ("wave", "w1")  # the first wave is selected at start
        await pilot.press("j")
        await pilot.pause()
        assert selected(app).key == ("wave", "w22")
        text = body(app)
        assert "rejected" in text and "blocker  src/x.ts:12  leaks the lock" in text and "task a" in text
        await pilot.press("k", "k")
        await pilot.pause()
        assert selected(app).kind == "group" and "5/6 done" in body(app)
        for _ in range(6):
            await pilot.press("down")
        await started(app, pilot)
        assert selected(app).key == ("task", "t-loose")
        text = body(app)
        assert "round  2" in text and "entry 29" in text and "entry 14" not in text and "entry 15" in text
        await pilot.press("l")
        assert focused_id(app) == "detail"
        await pilot.press("h")
        assert focused_id(app) == "tree"


async def test_filter_and_refresh_keeps_selection():
    client = FakeClient()
    app = FactoryView(client, refresh_seconds=0)
    async with app.run_test(size=(140, 40)) as pilot:
        await started(app, pilot)
        await pilot.press("slash", *"loose")
        await pilot.pause()
        assert labels(app) == ["/repo", "  tasks  1", "    running  a loose task"]
        await pilot.press("enter")
        await started(app, pilot)
        assert selected(app).key == ("task", "t-loose")
        await pilot.press("escape")
        await started(app, pilot)
        assert len(labels(app)) == 9
        assert selected(app).key == ("task", "t-loose")
        calls = client.calls.count("tasks.list")
        await pilot.press("r")
        await started(app, pilot)
        assert client.calls.count("tasks.list") == calls + 1
        assert selected(app).key == ("task", "t-loose")


async def test_unknown_waves_list_still_shows_tasks():
    # What FactoryClient.waves does with an `unknown action` error: no waves, no error shown.
    from factory_tui.client import FactoryClient

    class OldFactory(FactoryClient):
        def call(self, action, params=None):
            if action == "waves.list":
                raise FactoryCliError("invalid", 'unknown action "waves.list"')
            return {"repos": ["/repo"]} if action == "repos.list" else {"tasks": [task("t1", "old task")]}

    app = FactoryView(OldFactory("unused"), refresh_seconds=0)
    async with app.run_test(size=(140, 40)) as pilot:
        await started(app, pilot)
        assert labels(app) == ["/repo", "  tasks  1", "    running  old task"]
        assert app.snapshot.errors == []


async def test_other_errors_are_shown():
    app = FactoryView(FakeClient(waves_error=FactoryCliError("failed", "boom")), refresh_seconds=0)
    async with app.run_test(size=(140, 40)) as pilot:
        await started(app, pilot)
        assert app.snapshot.errors == ["waves: failed: boom"]
        assert labels(app)[-1] == "    running  a loose task"


async def test_q_quits():
    app = FactoryView(FakeClient(), refresh_seconds=0)
    async with app.run_test() as pilot:
        await pilot.press("q")
        assert not app.is_running


async def test_refresh_keeps_the_cursor_on_a_repository_row():
    client = FakeClient()
    app = FactoryView(client, refresh_seconds=0)
    async with app.run_test(size=(140, 40)) as pilot:
        await started(app, pilot)
        await pilot.press("k", "k", "k")  # w1 -> m1 -> factory -> /repo
        await pilot.pause()
        assert selected(app).key == ("repo", "/repo")
        await pilot.press("r")
        await started(app, pilot)
        assert selected(app).key == ("repo", "/repo")
        cursor = app.query_one(Tree).cursor_node
        assert cursor is not None and cursor.data is not None and cursor.data.key == ("repo", "/repo")


async def test_wrong_shaped_json_is_an_error_line_not_a_crash():
    broken_wave = {**wave("w4444", "x/w1", 0, 1), "counts": "lots"}
    detail_broken = {**wave("w55555", "y/w1", 0, 1), "tasks": [{"title": "no key or state"}]}
    client = FakeClient(waves=[broken_wave, detail_broken, "not a wave"], tasks=[task("t1", "fine"), {"id": "t2"}])
    app = FactoryView(client, refresh_seconds=0)
    async with app.run_test(size=(140, 40)) as pilot:
        await started(app, pilot)
        assert app.is_running
        assert app.snapshot.errors == [
            "waves: w4444: counts: not an object",
            "waves: 2: not an object",
            "tasks: t2: repo is not str",
        ]
        assert [w["id"] for w in app.snapshot.waves] == ["w55555"]
        assert selected(app).key == ("wave", "w55555")
        assert "cannot show this wave: unexpected JSON (KeyError" in body(app)


async def test_null_usage_everywhere():
    quiet = wave("w1", "a/w1", 0, 1, usage=None)
    quiet["tasks"][0]["usage"] = None
    loose = {**task("t1", "loose"), "usage": None}
    app = FactoryView(FakeClient(waves=[quiet], tasks=[loose]), refresh_seconds=0)
    async with app.run_test(size=(140, 40)) as pilot:
        await started(app, pilot)
        assert app.snapshot.errors == []
        assert labels(app)[1] == "  a  0/1"  # no cost on the group
        assert labels(app)[2].startswith("    w1  0/1  building  title w1")
        assert "usage  none" in body(app)
        await pilot.press("k")
        await pilot.pause()
        assert "usage  none" in body(app)  # the group sums nothing
        for _ in range(4):
            await pilot.press("down")
        await started(app, pilot)
        assert selected(app).key == ("task", "t1") and "usage  none" in body(app)


async def test_wave_without_tasks():
    empty = wave("w1", "a/w1", 0, 0, tasks=[], usage=None)
    app = FactoryView(FakeClient(waves=[empty], tasks=[]), refresh_seconds=0)
    async with app.run_test(size=(140, 40)) as pilot:
        await started(app, pilot)
        assert labels(app) == ["/repo", "  a  0/0", "    w1  0/0  building  title w1"]
        assert selected(app).key == ("wave", "w1")
        assert "tasks\n  none" in body(app)


async def test_a_queued_wave_shows_what_it_waits_for():
    first = wave("w1", "q/w1", 0, 1, stage="rejected")
    queued = wave("w22", "q/w2", 0, 1, stage="queued", branch=None, base=None, after=["w1", "gone4567-rest"])
    never = wave(
        "w333", "q/w3", 0, 1, stage="queued", branch=None, base=None, after=["w1"], detail="it can never start"
    )
    app = FactoryView(FakeClient(waves=[first, queued, never], tasks=[]), refresh_seconds=0)
    async with app.run_test(size=(140, 40)) as pilot:
        await started(app, pilot)
        assert app.snapshot.errors == []
        assert labels(app)[3].startswith("    w2  0/1  queued")
        await pilot.press("j")
        await pilot.pause()
        assert selected(app).key == ("wave", "w22")
        text = body(app)
        assert "after  q/w1, gone4567" in text and "branch none yet → central" in text and "why" not in text
        await pilot.press("j")
        await pilot.pause()
        assert "why    it can never start" in body(app)
