import { log } from "../core.js";
import { event } from "../events.js";
import {
  norm,
  scanDesiredChannelOwnership
} from "./core.js";
import { ensureOpen, ensureClosed, listManaged } from "./manage.js";
import { reconcileRotationAssignments } from "./rotation.js";
import { buildDesiredState } from "../planner/desired-state.js";
import { classify, compareRank, rank } from "../planner/hierarchy.js";
import {
  buildPhaseDRotationPlan,
  isPhaseDRotationEnabled,
  pruneRotationSlots
} from "../rotation.js";

const OPEN_STAGGER_MS = 4000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function closeManagedOutsidePlan(plan, { preserveChannels = new Set() } = {}) {
  const managed = await listManaged();
  const toClose = [];

  for (const ch of managed) {
    if (preserveChannels.has(ch)) continue;

    if (plan.externalSatisfied.includes(ch)) {
      toClose.push({ channel: ch, reason: "external_tab_already_satisfies_channel" });
      continue;
    }

    if (!plan.liveSet.has(ch)) {
      toClose.push({ channel: ch, reason: "not_in_confirmed_live_set" });
      continue;
    }

    if (!plan.desiredManagedSet.has(ch)) {
      toClose.push({ channel: ch, reason: "hierarchy_capacity" });
    }
  }

  // Close the lowest-ranked tabs first when capacity/hierarchy changes.
  toClose.sort((a, b) => compareRank(b.channel, a.channel, plan.hierarchy));

  for (const item of toClose) {
    await ensureClosed(item.channel, item.reason);
    await event("PLAN_CLOSE", {
      channel: item.channel,
      reason: item.reason,
      class: classify(item.channel, plan.hierarchy),
      rank: rank(item.channel, plan.hierarchy)
    });
  }
}

async function enforceOwnedCap(plan) {
  const ownedCap = Number(plan.ownedCap || plan.maxTabs || 0);
  let managed = await listManaged();
  if (managed.length <= ownedCap) return;

  const orderedWorstFirst = managed
    .slice()
    .sort((a, b) => compareRank(b, a, plan.hierarchy));

  while (managed.length > ownedCap && orderedWorstFirst.length) {
    const ch = orderedWorstFirst.shift();
    await ensureClosed(ch, "strict_max_tabs_cap");
    await event("STRICT_CAP_CLOSE", {
      channel: ch,
      maxTabs: plan.maxTabs,
      ownedCap,
      class: classify(ch, plan.hierarchy),
      rank: rank(ch, plan.hierarchy)
    });
    managed = await listManaged();
  }
}

async function makePlan(normalizedLive, cfg) {
  // The preliminary plan is only used to discover user-open tabs for these
  // configured live channels. User tabs satisfy a channel but never consume
  // TTM's owned max-tabs capacity.
  const preliminary = buildDesiredState(normalizedLive, cfg);
  const ownership = await scanDesiredChannelOwnership(preliminary.liveConfigured);
  const externalOpenChannels = [...ownership.external];

  if (isPhaseDRotationEnabled(cfg)) {
    return await buildPhaseDRotationPlan(normalizedLive, cfg, { externalOpenChannels });
  }
  return buildDesiredState(normalizedLive, cfg, { externalOpenChannels });
}

export async function reconcileTabs(live, cfg = {}) {
  const normalizedLive = [...new Set((Array.isArray(live) ? live : []).map(norm).filter(Boolean))];
  const phaseD = isPhaseDRotationEnabled(cfg);
  const plan = await makePlan(normalizedLive, cfg);

  const ownedCap = Number(plan.ownedCap || plan.maxTabs || 0);

  log("desired_state_plan", {
    max_tabs: plan.maxTabs,
    owned_cap: ownedCap,
    live: plan.liveConfigured,
    desired_managed: plan.desiredManaged,
    external_satisfied: plan.externalSatisfied,
    waiting: plan.waiting,
    currently_managed: await listManaged(),
    hierarchy: plan.details,
    phase_d_rotation: phaseD ? plan.rotation : null
  });

  await event("DESIRED_STATE", {
    maxTabs: plan.maxTabs,
    ownedCap,
    desiredManaged: plan.desiredManaged,
    externalSatisfied: plan.externalSatisfied,
    waiting: plan.waiting,
    phaseDRotation: phaseD
  });

  if (phaseD) {
    await event("ROTATION_PLAN", {
      requestedSlots: plan.rotation.requestedSlots,
      effectiveSlots: plan.rotation.effectiveSlots,
      stableCapacity: plan.rotation.stableCapacity,
      rotationCapacity: plan.rotation.rotationCapacity,
      ownedCap,
      candidates: plan.rotation.candidates,
      selected: plan.rotation.selected,
      assignments: plan.rotation.assignments.map((item) => ({
        slotIndex: item.slotIndex,
        tabId: item.tabId,
        previousChannel: item.previousChannel,
        channel: item.channel,
        changed: item.changed,
        due: item.due,
        reason: item.reason
      }))
    });
  }

  // Before rotating, free stable tabs that are no longer desired, but preserve
  // live rotation candidates temporarily so Phase D can reuse their existing
  // tabs instead of closing/reopening them.
  const preservedForRotation = phaseD && plan.rotation.assignments.length
    ? new Set(plan.rotation.candidates)
    : new Set();
  await closeManagedOutsidePlan(plan, { preserveChannels: preservedForRotation });

  let rotationResult = { tabIds: [], channels: [] };
  if (phaseD) {
    rotationResult = await reconcileRotationAssignments(plan.rotation);
    await event("ROTATION_RECONCILED", {
      tabIds: rotationResult.tabIds,
      channels: rotationResult.channels,
      selected: plan.rotation.selected
    });

    // Anything preserved only as a potential reusable rotation tab can now be
    // removed if it was not selected for this interval.
    await closeManagedOutsidePlan(plan);
    await pruneRotationSlots(plan.rotation.rotationCapacity);
  }

  let managedSet = new Set(await listManaged());

  for (const ch of plan.desiredManaged) {
    if (managedSet.has(ch)) continue;

    const reason = classify(ch, plan.hierarchy);
    if (managedSet.size >= ownedCap) {
      log("plan_open_waiting_for_capacity", {
        channel: ch,
        reason,
        managed_count: managedSet.size,
        max_tabs: plan.maxTabs,
        owned_cap: ownedCap
      });
      await event("PLAN_WAIT_CAPACITY", {
        channel: ch,
        reason,
        managedCount: managedSet.size,
        maxTabs: plan.maxTabs,
        ownedCap
      });
      continue;
    }

    try {
      const tabId = await ensureOpen(ch, reason);
      if (tabId) {
        managedSet.add(ch);
        await event("PLAN_OPEN", {
          channel: ch,
          tabId,
          reason,
          rank: rank(ch, plan.hierarchy)
        });

        // Twitch + player extensions are expensive to initialize. Opening a
        // whole desired set simultaneously made hidden players much more likely
        // to stall, so give each newly-created managed tab a short head start.
        if (managedSet.size < plan.desiredManaged.length && managedSet.size < ownedCap) {
          await event("PLAN_OPEN_STAGGER", { tabId, channel: ch, delayMs: OPEN_STAGGER_MS });
          await sleep(OPEN_STAGGER_MS);
        }
      } else {
        // ensureOpen returns null when a user-open tab appeared between plan
        // creation and execution. Treat that as satisfied, not as a failure.
        log("plan_open_satisfied_externally", { channel: ch, reason });
      }
    } catch (e) {
      log("plan_open_error", { channel: ch, reason, error: String(e) });
    }
  }

  await enforceOwnedCap(plan);

  const finalManaged = await listManaged();
  log("reconcile_done", {
    max_tabs: plan.maxTabs,
    owned_cap: ownedCap,
    managed: finalManaged,
    external_satisfied: plan.externalSatisfied,
    waiting: plan.waiting,
    managed_count: finalManaged.length,
    phase_d_rotation: phaseD ? {
      selected: plan.rotation.selected,
      tabIds: rotationResult.tabIds
    } : null
  });

  return {
    managed: finalManaged,
    desiredManaged: plan.desiredManaged,
    externalSatisfied: plan.externalSatisfied,
    waiting: plan.waiting,
    maxTabs: plan.maxTabs,
    ownedCap,
    details: plan.details,
    rotation: phaseD ? {
      ...plan.rotation,
      activeTabIds: rotationResult.tabIds
    } : null
  };
}
