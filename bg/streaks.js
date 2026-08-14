import * as manager from "./streaks/manager.js";

const T = (globalThis.TTM = globalThis.TTM || {});

T.injectStreakHelper = manager.injectStreakHelper;
T.onTwitchTabCompleteForStreaks = manager.onTwitchTabComplete;
T.handleStreakScan = manager.handleStreakScan;
T.handleStreakPlayback = manager.handleStreakPlayback;
T.runStreakRescueTick = manager.runStreakRescueTick;
T.getStreakRescueStatus = manager.getStreakRescueStatus;
T.initStreakRescue = manager.initStreakRescue;

export const injectStreakHelper = manager.injectStreakHelper;
export const onTwitchTabComplete = manager.onTwitchTabComplete;
export const handleStreakScan = manager.handleStreakScan;
export const handleStreakPlayback = manager.handleStreakPlayback;
export const runStreakRescueTick = manager.runStreakRescueTick;
export const getStreakRescueStatus = manager.getStreakRescueStatus;
export const initStreakRescue = manager.initStreakRescue;
