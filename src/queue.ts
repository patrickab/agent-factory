/**
 * The merge queue of a repository: who may run the merge gates and move the target next. Shared by every task of the
 * repository, each in its own process, through ticket files in its git directory: first come, first served.
 * - A ticket whose owner no longer runs is removed on the way: pid and start time must match (`procAlive`), which
 *   also catches a reused pid
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { procAlive, procStart } from "./tasks.ts";

const QUEUE_DIR = "factory-merge-queue";

export interface Ticket {
  path: string;
  name: string;
}

/** A ticket of this process in the queue of the repository whose git common dir is `gitDir`. */
export async function joinQueue(gitDir: string): Promise<Ticket> {
  const dir = join(gitDir, QUEUE_DIR);
  await mkdir(dir, { recursive: true });
  const owner = `${process.pid}-${(await procStart(process.pid)) ?? "0"}`;
  const name = `${String(Date.now()).padStart(15, "0")}-${owner}-${randomUUID().slice(0, 8)}`;
  await writeFile(join(dir, name), "");
  return { path: join(dir, name), name };
}

/** How many live tickets are ahead of `ticket`, removing those whose owner no longer runs. */
export async function queueAhead(ticket: Ticket): Promise<number> {
  const dir = join(ticket.path, "..");
  let ahead = 0;
  for (const name of (await readdir(dir)).sort()) {
    if (name >= ticket.name) continue;
    const [, pid = "", start = ""] = name.split("-");
    if (!(await procAlive(Number(pid), start))) {
      await rm(join(dir, name), { force: true });
      continue;
    }
    ahead += 1;
  }
  return ahead;
}

export async function leaveQueue(ticket: Ticket): Promise<void> {
  await rm(ticket.path, { force: true });
}
