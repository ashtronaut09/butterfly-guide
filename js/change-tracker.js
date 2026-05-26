/**
 * change-tracker.js — Tracks unsaved changes since last export
 *
 * Uses localStorage to persist a change counter across page reloads.
 * The counter increments on every specimen edit/add/delete and photo
 * add/delete. Resets to 0 when the user exports the collection.
 */

const STORAGE_KEY = 'butterfly_changes_since_export';

/**
 * Returns the current number of unsaved changes.
 * @returns {number}
 */
export function getChangeCount() {
  const val = localStorage.getItem(STORAGE_KEY);
  return val ? parseInt(val, 10) || 0 : 0;
}

/**
 * Increments the change counter by 1.
 * @returns {number} the new count
 */
export function incrementChanges() {
  const count = getChangeCount() + 1;
  localStorage.setItem(STORAGE_KEY, String(count));
  return count;
}

/**
 * Resets the change counter to 0. Called after a successful export.
 */
export function resetChanges() {
  localStorage.setItem(STORAGE_KEY, '0');
}

/**
 * Returns a human-readable summary string, or empty string if no changes.
 * Examples:
 *   ""                           (0 changes)
 *   "1 unsaved change"           (1 change)
 *   "12 unsaved changes"         (plural)
 * @returns {string}
 */
export function getChangesSummary() {
  const count = getChangeCount();
  if (count === 0) return '';
  return `${count} unexported change${count === 1 ? '' : 's'}`;
}
