/**
 * The features (`feature.ts`), one line each: the core ones first (settings, tasks, wait, waves), then the others
 * sorted. Their order is the order of the action list, of the `factory` tool's description and of the notices.
 */
import { SETTINGS } from "./feature-settings.ts";
import { TASKS } from "./feature-tasks.ts";
import { WAIT } from "./feature-wait.ts";
import { WAVES } from "./feature-waves.ts";
import { CONTRACTS } from "./feature-contracts.ts";
import { GATES } from "./feature-gates.ts";
import { PLAN } from "./feature-plan.ts";
import { SCOUTS } from "./feature-scouts.ts";

export const FEATURES = [
  SETTINGS,
  TASKS,
  WAIT,
  WAVES,
  CONTRACTS,
  GATES,
  PLAN,
  SCOUTS,
] as const;
