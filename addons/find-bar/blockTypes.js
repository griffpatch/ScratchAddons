/**
 * Block type constants for categorizing and identifying Scratch blocks
 */

// Variable-related blocks
export const VARIABLE_BLOCKS = new Set([
  "data_variable",
  "data_changevariableby",
  "data_setvariableto",
  "data_showvariable",
  "data_hidevariable",
]);

// List-related blocks
export const LIST_BLOCKS = new Set([
  "data_listcontents",
  "data_addtolist",
  "data_deleteoflist",
  "data_deletealloflist",
  "data_insertatlist",
  "data_replaceitemoflist",
  "data_itemoflist",
  "data_itemnumoflist",
  "data_lengthoflist",
  "data_listcontainsitem",
  "data_showlist",
  "data_hidelist",
]);

// Broadcast-related blocks
export const BROADCAST_BLOCKS = new Set(["event_whenbroadcastreceived", "event_broadcastandwait", "event_broadcast"]);

// Clone-related blocks
export const CLONE_BLOCKS = new Set(["control_start_as_clone", "control_create_clone_of", "control_delete_this_clone"]);

// Procedure-related blocks
export const PROCEDURE_BLOCKS = new Set(["procedures_definition", "procedures_call"]);

/**
 * Check if a block type is a variable block
 * @param {string} type - Block type
 * @returns {boolean}
 */
export function isVariableBlock(type) {
  return VARIABLE_BLOCKS.has(type);
}

/**
 * Check if a block type is a list block
 * @param {string} type - Block type
 * @returns {boolean}
 */
export function isListBlock(type) {
  return LIST_BLOCKS.has(type);
}

/**
 * Check if a block type is a broadcast block
 * @param {string} type - Block type
 * @returns {boolean}
 */
export function isBroadcastBlock(type) {
  return BROADCAST_BLOCKS.has(type);
}

/**
 * Check if a block type is a clone block
 * @param {string} type - Block type
 * @returns {boolean}
 */
export function isCloneBlock(type) {
  return CLONE_BLOCKS.has(type);
}

/**
 * Check if a block type is a procedure block
 * @param {string} type - Block type
 * @returns {boolean}
 */
export function isProcedureBlock(type) {
  return PROCEDURE_BLOCKS.has(type);
}

/**
 * Check if a block type is an event hat block (starts with "event_when")
 * @param {string} type - Block type
 * @returns {boolean}
 */
export function isEventBlock(type) {
  return type && type.startsWith("event_when");
}

/**
 * Check if a block can be explored (middle-click or context menu)
 * @param {string} type - Block type
 * @returns {boolean}
 */
export function isExplorableBlock(type) {
  return (
    isProcedureBlock(type) ||
    isVariableBlock(type) ||
    isListBlock(type) ||
    isBroadcastBlock(type) ||
    isCloneBlock(type) ||
    isEventBlock(type)
  );
}
