import {
  chanFromUrl,
  isChannelUrl,
  isManaged,
  getRotationSlot,
  setRotationSlot,
  clearRotationSlot,
  wasRecentlyUsedInRotation,
  markRotationChannelUsed,
  ensureBackgroundTabLoaded,
  makeTabBackgroundSafe
} from "./tabs/core.js";
import {
  adoptOpenTabs,
  ensureOpen,
  ensureClosed,
  releaseOwnedTab,
  listManaged,
  listOpenTabs
} from "./tabs/manage.js";
import { reconcileTabs } from "./tabs/reconcile.js";
import { reconcileRotationAssignments, ensureRotationAssignment } from "./tabs/rotation.js";

const T = (globalThis.TTM = globalThis.TTM || {});

T.channelFromUrl = chanFromUrl;
T.isChannelUrl = isChannelUrl;
T.isManaged = isManaged;
T.listOpenTabs = listOpenTabs;
T.listManaged = listManaged;
T.ensureOpen = ensureOpen;
T.ensureClosed = ensureClosed;
T.releaseOwnedTab = releaseOwnedTab;
T.adoptOpenTabs = adoptOpenTabs;
T.ensureBackgroundTabLoaded = ensureBackgroundTabLoaded;
T.makeTabBackgroundSafe = makeTabBackgroundSafe;
T.getRotationSlot = getRotationSlot;
T.setRotationSlot = setRotationSlot;
T.clearRotationSlot = clearRotationSlot;
T.wasRecentlyUsedInRotation = wasRecentlyUsedInRotation;
T.markRotationChannelUsed = markRotationChannelUsed;
T.reconcileRotationAssignments = reconcileRotationAssignments;
T.ensureRotationAssignment = ensureRotationAssignment;

if (typeof self === "object") {
  self.bgTabs = self.bgTabs || {};
  self.bgTabs.reconcile = (liveCfg) =>
    reconcileTabs(liveCfg.liveList || liveCfg, {
      ...liveCfg,
      max_tabs: liveCfg.maxTabs || liveCfg.max_tabs
    });
  self.bgTabs.listManaged = listManaged;
}

export {
  chanFromUrl,
  isChannelUrl,
  isManaged,
  getRotationSlot,
  setRotationSlot,
  clearRotationSlot,
  wasRecentlyUsedInRotation,
  markRotationChannelUsed,
  ensureBackgroundTabLoaded,
  makeTabBackgroundSafe,
  adoptOpenTabs,
  ensureOpen,
  ensureClosed,
  releaseOwnedTab,
  listManaged,
  listOpenTabs,
  reconcileRotationAssignments,
  ensureRotationAssignment,
  reconcileTabs
};
