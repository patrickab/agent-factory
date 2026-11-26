/** `contracts.apply`: one fact of a contract changed, the tasks of the waves listing it told (`core-contracts.ts`). */
import { plural } from "./agent-view.ts";
import { CONTRACT_HANDLERS } from "./core-contracts.ts";
import { feature, spec } from "./feature.ts";
import type { Handlers } from "./feature.ts";

type ContractTask = { wave: string; tag: string; key: string; task: string };

export const CONTRACTS = feature({
  name: "contracts",
  actions: {
    "contracts.apply": spec(
      "Change one fact of a contract (one memory-store op) and tell the tasks of every wave listing it: running ones get a follow-up, others keep it for their next turn (waiting_answer: with its answer), pending ones nothing; done ones are answered and reported. Answers {store, name, changed, notified, kept, done}",
      {
        store: { type: "string", description: "The memory-store of the contract (the waves' plan)" },
        name: { type: "string", description: "The contract's name (run/contract/<name>/ or run/contract/<name>.md)" },
        op: {
          type: "object",
          description: "One memory-store op: {op: add|update|retire|write_doc, path: the fact's path inside the contract, ...} (a one-document contract: write_doc, path omitted)",
        },
      },
      ["store", "name", "op"],
      true,
    ),
  },
  get handlers(): Handlers {
    return CONTRACT_HANDLERS;
  },
  renderers: {
    "contracts.apply": (_params, result: { name: string; changed: string[]; notified: ContractTask[]; kept: ContractTask[]; done: ContractTask[] }) => {
      const keys = (tasks: ContractTask[]) => tasks.map((task) => `${task.tag}:${task.key}`).join(", ");
      if (result.changed.length === 0) return `contract ${result.name}: nothing changed`;
      return [
        `contract ${result.name}: ${plural(result.changed.length, "fact")} changed`,
        ...(result.notified.length > 0 ? [`told: ${keys(result.notified)}`] : []),
        ...(result.kept.length > 0 ? [`next turn: ${keys(result.kept)}`] : []),
        ...(result.done.length > 0 ? [`done, may need a follow-up task: ${keys(result.done)}`] : []),
      ].join(" · ");
    },
  },
  toolBlurb: '"contracts.apply" changes one fact of a contract the waves list and tells their tasks.',
});
