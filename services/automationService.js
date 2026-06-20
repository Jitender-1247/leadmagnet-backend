/**
 * automationService.js
 * Re-exports from Scheduler.js for backward compatibility.
 * Scheduler.js now contains all automation logic directly.
 */

const {
  runCampaign,
  processFollowUps,
  processQueue,
  isSafeToRun,
} = require('./Scheduler');

const { checkForReplies } = require('./linkedinService');

module.exports = {
  runCampaign,
  processFollowUps,
  processQueue,
  isSafeToRun,
  checkForReplies,
};