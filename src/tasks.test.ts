import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listTasks, lockTask, removeTask, taskLockPath, taskLogPath, tasksDir, writeTask, type TaskRecord } from "./tasks.ts";
import { unlockFile } from "./lock.ts";
import { restoreEnv } from "./core-test-kit.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "factory-tasks-test-")));
const savedEnv = { ...process.env };
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");

afterAll(() => {
  restoreEnv(savedEnv);
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(join(scratch, "agent"), { recursive: true, force: true });
});

/** A task id of the shape `crypto.randomUUID` makes, `n` in its last digits. */
function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}
const ONE = uuid(1);

function record(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    repo: "/repo/a",
    worktree: `/worktrees/a/${id}`,
    branch: `task-${id}`,
    title: `Task ${id}`,
    sessionId: `session-${id}`,
    sessionDir: join(scratch, "sessions"),
    createdAt: "2026-01-01T00:00:00.000Z",
    tag: "team",
    plan: null,
    wave: null,
    origin: null,
    ...overrides,
  };
}

describe("task records", () => {
  test("listTasks: oldest first, filtered by repo, skips invalid, foreign and temp files", async () => {
    const [late, early, other] = [uuid(2), uuid(3), uuid(4)];
    await writeTask(record(late, { createdAt: "2026-03-01T00:00:00.000Z" }));
    await writeTask(record(early, { createdAt: "2026-02-01T00:00:00.000Z" }));
    await writeTask(record(other, { repo: "/repo/b" }));
    writeFileSync(join(tasksDir(), `${uuid(5)}.json`), "{");
    writeFileSync(join(tasksDir(), "x.json.1.tmp"), "{}");
    writeFileSync(join(tasksDir(), `${uuid(7)}.json`), JSON.stringify(record("../../x")));
    writeFileSync(join(tasksDir(), `${uuid(8)}.json`), JSON.stringify(record(uuid(9))));
    expect((await listTasks()).map((task) => task.id)).toEqual([other, early, late]);
    expect((await listTasks("/repo/a")).map((task) => task.id)).toEqual([early, late]);
  });

  test("removeTask removes the record, its log and its lock, and tolerates a missing one", async () => {
    await writeTask(record(ONE));
    writeFileSync(taskLogPath(ONE), "log");
    await lockTask(ONE);
    await removeTask(ONE);
    expect(readdirSync(tasksDir())).toEqual([]);
    await removeTask(ONE);
  });
});

describe("task lock", () => {
  test("one holder at a time; this process holds it until it unlocks", async () => {
    await lockTask(ONE);
    await expect(lockTask(ONE)).rejects.toMatchObject({ code: "busy" });
    await unlockFile(taskLockPath(ONE));
    expect(existsSync(taskLockPath(ONE))).toBe(false);
  });

  test("a lock whose holder no longer runs is taken over; unlock leaves another holder's lock alone", async () => {
    mkdirSync(tasksDir(), { recursive: true });
    writeFileSync(taskLockPath(ONE), "2147483646 0\n");
    await lockTask(ONE);
    writeFileSync(taskLockPath(ONE), "1 0\n");
    await unlockFile(taskLockPath(ONE));
    expect(readFileSync(taskLockPath(ONE), "utf8")).toBe("1 0\n");
  });
});
