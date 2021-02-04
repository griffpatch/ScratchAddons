import { BOMBlock } from "./BOMBlock.js";

export default class BOMProject {
  /**
   *
   * @param vm {VirtualMachine}
   */
  constructor(vm, utils) {
    this.utils = utils;
    this._parseProject(vm);
  }

  static init(addon) {
    if (!_blockly) {
      addon.tab.traps.getBlockly().then(instanceMapFrom);
    }
  }

  _parseProject(vm) {
    const runtime = vm.runtime;
    const targets = runtime.targets; // The sprites / stage

    let dict = {};

    for (const target of targets) {
      if (!target.isOriginal) {
        continue; // Skip clones
      }

      const name = target.getName();
      const isStage = target.isStage;
      const blocks = target.blocks;

      const scripts = blocks.getScripts(); // Top level scripts for sprite

      const sprite = (dict[name] = {});
      sprite.scripts = [];

      for (const script of scripts) {
        const block = blocks.getBlock(script);

        const top = { id: script, opcode: block.opcode, block: block };
        sprite.scripts.push(top);

        // Recurse through scripts
        this.recurseBlockStack(blocks, block);
      }
    }
  }

  /**
   * Blockly inputs that represent statements/branch.
   * are prefixed with this string.
   * @const{string}
   */
  static get BRANCH_INPUT_PREFIX() {
    return "SUBSTACK";
  }

  /**
   *
   * @param blocks {Blocks}
   * @param block {?object}
   */
  recurseBlockStack(blocks, block) {
    let opcode = block.opcode.toUpperCase();
    let msgElement = _blockly.Msg[opcode];
    // let sanitise = msgElement.replace(/%\d/g, "()");

    // let workspace = this.utils.getWorkspace();

    // _blockly.Events.disable();
    // var createBlock = new _blockly.Block(workspace, block.opcode);
    // blocks.createBlock().deleteBlock(createBlock.id);
    // _blockly.Events.enable();

    // console.log(sanitise);

    if (block.next) {
      this.recurseBlockStack(blocks, blocks.getBlock(block.next));
    }

    // let inputName = BOMProject.BRANCH_INPUT_PREFIX;
    //
    // if (branchNum > 1) {
    //   inputName += branchNum;
    // }
    //
    // // Empty C-block?
    // const input = block.inputs[inputName];
    // return typeof input === "undefined" ? null : input.block;
  }
}

/**
 * @type {Blockly}
 */
let _blockly;
/**
 * @type {{string: BOMBlock}}
 * @private
 */
let _map;

/**
 * @param blockly {Blockly}
 */
function instanceMapFrom(blockly) {
  _blockly = blockly;
  const map = {};
  [
    // new BOMBlock({ opcode: "argument_editor_boolean" }, blockly),
    // new BOMBlock({ opcode: "argument_editor_string_number" }, blockly),
    // new BOMBlock({ opcode: "argument_reporter_boolean" }, blockly),
    // new BOMBlock({ opcode: "argument_reporter_string_number" }, blockly),
    // new BOMBlock({ opcode: "colour" }, blockly),
    // new BOMBlock({ opcode: "colour_picker" }, blockly),
    // new BOMBlock({ opcode: "control" }, blockly),
    // new BOMBlock({ opcode: "control_all_at_once" }, blockly),
    // new BOMBlock({ opcode: "control_clear_counter" }, blockly),
    new BOMBlock({ opcode: "control_create_clone_of", bid: "CONTROL_CREATECLONEOF" }, blockly),
    // new BOMBlock({ opcode: "control_create_clone_of_menu" }, blockly),
    new BOMBlock({ opcode: "control_delete_this_clone", bid: "CONTROL_DELETETHISCLONE" }, blockly),
    new BOMBlock({ opcode: "control_for_each", bid: "CONTROL_FOREACH", deprecated: true }, blockly),
    new BOMBlock({ opcode: "control_forever", bid: "CONTROL_FOREVER" }, blockly),
    // new BOMBlock({ opcode: "control_get_counter" }, blockly),
    new BOMBlock({ opcode: "control_if" }, blockly),
    new BOMBlock({ opcode: "control_if_else", bid: ["CONTROL_IF", "CONTROL_ELSE"] }, blockly),
    // new BOMBlock({ opcode: "control_incr_counter" }, blockly),
    new BOMBlock({ opcode: "control_repeat" }, blockly),
    new BOMBlock({ opcode: "control_repeat_until", bid: "CONTROL_REPEATUNTIL" }, blockly),
    new BOMBlock({ opcode: "control_start_as_clone", bid: "CONTROL_STARTASCLONE" }, blockly),
    new BOMBlock({ opcode: "control_stop" }, blockly),
    new BOMBlock({ opcode: "control_wait" }, blockly),
    new BOMBlock({ opcode: "control_wait_until", bid: "CONTROL_WAITUNTIL" }, blockly),
    new BOMBlock({ opcode: "control_while" }, blockly),
    // new BOMBlock({ opcode: "data" }, blockly),
    new BOMBlock({ opcode: "data_addtolist" }, blockly),
    new BOMBlock({ opcode: "data_changevariableby" }, blockly),
    new BOMBlock({ opcode: "data_deletealloflist" }, blockly),
    new BOMBlock({ opcode: "data_deleteoflist" }, blockly),
    new BOMBlock({ opcode: "data_hidelist" }, blockly),
    new BOMBlock({ opcode: "data_hidevariable" }, blockly),
    new BOMBlock({ opcode: "data_insertatlist" }, blockly),
    new BOMBlock({ opcode: "data_itemnumoflist" }, blockly),
    new BOMBlock({ opcode: "data_itemoflist" }, blockly),
    new BOMBlock({ opcode: "data_lengthoflist" }, blockly),
    new BOMBlock({ opcode: "data_listcontainsitem" }, blockly),
    // new BOMBlock({ opcode: "data_listcontents" }, blockly),
    // new BOMBlock({ opcode: "data_listindexall" }, blockly),
    // new BOMBlock({ opcode: "data_listindexrandom" }, blockly),
    new BOMBlock({ opcode: "data_replaceitemoflist" }, blockly),
    new BOMBlock({ opcode: "data_setvariableto" }, blockly),
    new BOMBlock({ opcode: "data_showlist" }, blockly),
    new BOMBlock({ opcode: "data_showvariable" }, blockly),
    // new BOMBlock({ opcode: "data_variable" }, blockly),
    // new BOMBlock({ opcode: "defaultToolbox" }, blockly),
    // new BOMBlock({ opcode: "event" }, blockly),
    new BOMBlock({ opcode: "event_broadcast" }, blockly),
    // new BOMBlock({ opcode: "event_broadcast_menu" }, blockly),
    new BOMBlock({ opcode: "event_broadcastandwait" }, blockly),
    // new BOMBlock({ opcode: "event_touchingobjectmenu" }, blockly),
    new BOMBlock({ opcode: "event_whenbackdropswitchesto" }, blockly),
    new BOMBlock({ opcode: "event_whenbroadcastreceived" }, blockly),
    new BOMBlock({ opcode: "event_whenflagclicked" }, blockly),
    new BOMBlock({ opcode: "event_whengreaterthan" }, blockly),
    new BOMBlock({ opcode: "event_whenkeypressed" }, blockly),
    new BOMBlock({ opcode: "event_whenstageclicked" }, blockly),
    new BOMBlock({ opcode: "event_whenthisspriteclicked" }, blockly),
    new BOMBlock({ opcode: "event_whentouchingobject" }, blockly),
    // new BOMBlock({ opcode: "extension_microbit_display" }, blockly),
    // new BOMBlock({ opcode: "extension_music_drum" }, blockly),
    // new BOMBlock({ opcode: "extension_music_play_note" }, blockly),
    // new BOMBlock({ opcode: "extension_music_reporter" }, blockly),
    // new BOMBlock({ opcode: "extension_pen_down" }, blockly),
    // new BOMBlock({ opcode: "extension_wedo_boolean" }, blockly),
    // new BOMBlock({ opcode: "extension_wedo_hat" }, blockly),
    // new BOMBlock({ opcode: "extension_wedo_motor" }, blockly),
    // new BOMBlock({ opcode: "extension_wedo_tilt_menu" }, blockly),
    // new BOMBlock({ opcode: "extension_wedo_tilt_reporter" }, blockly),
    // new BOMBlock({ opcode: "extensions" }, blockly),
    // new BOMBlock({ opcode: "looks" }, blockly),
    new BOMBlock({ opcode: "looks_backdropnumbername" }, blockly),
    // new BOMBlock({ opcode: "looks_backdrops" }, blockly),
    new BOMBlock({ opcode: "looks_changeeffectby" }, blockly),
    new BOMBlock({ opcode: "looks_changesizeby" }, blockly),
    new BOMBlock({ opcode: "looks_changestretchby" }, blockly),
    new BOMBlock({ opcode: "looks_cleargraphiceffects" }, blockly),
    // new BOMBlock({ opcode: "looks_costume" }, blockly),
    new BOMBlock({ opcode: "looks_costumenumbername" }, blockly),
    new BOMBlock({ opcode: "looks_goforwardbackwardlayers" }, blockly),
    new BOMBlock({ opcode: "looks_gotofrontback" }, blockly),
    new BOMBlock({ opcode: "looks_hide" }, blockly),
    new BOMBlock({ opcode: "looks_hideallsprites" }, blockly),
    new BOMBlock({ opcode: "looks_nextbackdrop" }, blockly),
    new BOMBlock({ opcode: "looks_nextcostume" }, blockly),
    new BOMBlock({ opcode: "looks_say" }, blockly),
    new BOMBlock({ opcode: "looks_sayforsecs" }, blockly),
    new BOMBlock({ opcode: "looks_seteffectto" }, blockly),
    new BOMBlock({ opcode: "looks_setsizeto" }, blockly),
    new BOMBlock({ opcode: "looks_setstretchto" }, blockly),
    new BOMBlock({ opcode: "looks_show" }, blockly),
    new BOMBlock({ opcode: "looks_size" }, blockly),
    new BOMBlock({ opcode: "looks_switchbackdropto" }, blockly),
    new BOMBlock({ opcode: "looks_switchbackdroptoandwait" }, blockly),
    new BOMBlock({ opcode: "looks_switchcostumeto" }, blockly),
    new BOMBlock({ opcode: "looks_think" }, blockly),
    new BOMBlock({ opcode: "looks_thinkforsecs" }, blockly),
    // new BOMBlock({ opcode: "math" }, blockly),
    // new BOMBlock({ opcode: "math_angle" }, blockly),
    // new BOMBlock({ opcode: "math_integer" }, blockly),
    // new BOMBlock({ opcode: "math_number" }, blockly),
    // new BOMBlock({ opcode: "math_positive_number" }, blockly),
    // new BOMBlock({ opcode: "math_whole_number" }, blockly),
    // new BOMBlock({ opcode: "matrix" }, blockly),
    // new BOMBlock({ opcode: "motion" }, blockly),
    // new BOMBlock({ opcode: "motion_align_scene" }, blockly),
    new BOMBlock({ opcode: "motion_changexby" }, blockly),
    new BOMBlock({ opcode: "motion_changeyby" }, blockly),
    new BOMBlock({ opcode: "motion_direction" }, blockly),
    new BOMBlock({ opcode: "motion_glidesecstoxy" }, blockly),
    new BOMBlock({ opcode: "motion_glideto" }, blockly),
    // new BOMBlock({ opcode: "motion_glideto_menu" }, blockly),
    new BOMBlock({ opcode: "motion_goto" }, blockly),
    // new BOMBlock({ opcode: "motion_goto_menu" }, blockly),
    new BOMBlock({ opcode: "motion_gotoxy" }, blockly),
    new BOMBlock({ opcode: "motion_ifonedgebounce" }, blockly),
    new BOMBlock({ opcode: "motion_movesteps" }, blockly),
    new BOMBlock({ opcode: "motion_pointindirection" }, blockly),
    new BOMBlock({ opcode: "motion_pointtowards" }, blockly),
    // new BOMBlock({ opcode: "motion_pointtowards_menu" }, blockly),
    // new BOMBlock({ opcode: "motion_scroll_right" }, blockly),
    // new BOMBlock({ opcode: "motion_scroll_up" }, blockly),
    new BOMBlock({ opcode: "motion_setrotationstyle" }, blockly),
    new BOMBlock({ opcode: "motion_setx" }, blockly),
    new BOMBlock({ opcode: "motion_sety" }, blockly),
    new BOMBlock({ opcode: "motion_turnleft" }, blockly),
    new BOMBlock({ opcode: "motion_turnright" }, blockly),
    new BOMBlock({ opcode: "motion_xposition" }, blockly),
    new BOMBlock({ opcode: "motion_xscroll" }, blockly),
    new BOMBlock({ opcode: "motion_yposition" }, blockly),
    new BOMBlock({ opcode: "motion_yscroll" }, blockly),
    // new BOMBlock({ opcode: "note" }, blockly),
    new BOMBlock({ opcode: "operator_add", bid: "OPERATORS_ADD" }, blockly),
    new BOMBlock({ opcode: "operator_and", bid: "OPERATORS_AND" }, blockly),
    new BOMBlock({ opcode: "operator_contains", bid: "OPERATORS_CONTAINS" }, blockly),
    new BOMBlock({ opcode: "operator_divide", bid: "OPERATORS_DIVIDE" }, blockly),
    new BOMBlock({ opcode: "operator_equals", bid: "OPERATORS_EQUALS" }, blockly),
    new BOMBlock({ opcode: "operator_gt", bid: "OPERATORS_GT" }, blockly),
    new BOMBlock({ opcode: "operator_join", bid: "OPERATORS_JOIN" }, blockly),
    new BOMBlock({ opcode: "operator_length", bid: "OPERATORS_LENGTH" }, blockly),
    new BOMBlock({ opcode: "operator_letter_of", bid: "OPERATORS_LETTEROF" }, blockly),
    new BOMBlock({ opcode: "operator_lt", bid: "OPERATORS_LT" }, blockly),
    new BOMBlock(
      {
        opcode: "operator_mathop",
        bid: [
          "OPERATORS_MATHOP",
          [
            "OPERATORS_MATHOP_ABS",
            "OPERATORS_MATHOP_FLOOR",
            "OPERATORS_MATHOP_CEILING",
            "OPERATORS_MATHOP_SQRT",
            "OPERATORS_MATHOP_SIN",
            "OPERATORS_MATHOP_COS",
            "OPERATORS_MATHOP_TAN",
            "OPERATORS_MATHOP_ASIN",
            "OPERATORS_MATHOP_ACOS",
            "OPERATORS_MATHOP_ATAN",
            "OPERATORS_MATHOP_LN",
            "OPERATORS_MATHOP_LOG",
            "OPERATORS_MATHOP_EEXP",
            "OPERATORS_MATHOP_10EXP",
          ],
        ],
      },
      blockly
    ),
    new BOMBlock({ opcode: "operator_mod", bid: "OPERATORS_MOD" }, blockly),
    new BOMBlock({ opcode: "operator_multiply", bid: "OPERATORS_MULTIPLY" }, blockly),
    new BOMBlock({ opcode: "operator_not", bid: "OPERATORS_NOT" }, blockly),
    new BOMBlock({ opcode: "operator_or", bid: "OPERATORS_OR" }, blockly),
    new BOMBlock({ opcode: "operator_random", bid: "OPERATORS_RANDOM" }, blockly),
    new BOMBlock({ opcode: "operator_round", bid: "OPERATORS_ROUND" }, blockly),
    new BOMBlock({ opcode: "operator_subtract", bid: "OPERATORS_SUBTRACT" }, blockly),
    // new BOMBlock({ opcode: "operators" }, blockly),
    // new BOMBlock({ opcode: "procedures_call" }, blockly),
    // new BOMBlock({ opcode: "procedures_declaration" }, blockly),
    new BOMBlock({ opcode: "procedures_definition" }, blockly),
    // new BOMBlock({ opcode: "procedures_prototype" }, blockly),
    // new BOMBlock({ opcode: "sensing" }, blockly),
    new BOMBlock({ opcode: "sensing_answer" }, blockly),
    new BOMBlock({ opcode: "sensing_askandwait" }, blockly),
    new BOMBlock({ opcode: "sensing_coloristouchingcolor" }, blockly),
    new BOMBlock({ opcode: "sensing_current" }, blockly),
    new BOMBlock({ opcode: "sensing_dayssince2000" }, blockly),
    new BOMBlock({ opcode: "sensing_distanceto" }, blockly),
    // new BOMBlock({ opcode: "sensing_distancetomenu" }, blockly),
    // new BOMBlock({ opcode: "sensing_keyoptions" }, blockly),
    new BOMBlock({ opcode: "sensing_keypressed" }, blockly),
    new BOMBlock({ opcode: "sensing_loud" }, blockly),
    new BOMBlock({ opcode: "sensing_loudness" }, blockly),
    new BOMBlock({ opcode: "sensing_mousedown" }, blockly),
    new BOMBlock({ opcode: "sensing_mousex" }, blockly),
    new BOMBlock({ opcode: "sensing_mousey" }, blockly),
    new BOMBlock({ opcode: "sensing_of" }, blockly),
    // new BOMBlock({ opcode: "sensing_of_object_menu" }, blockly),
    new BOMBlock({ opcode: "sensing_resettimer" }, blockly),
    new BOMBlock({ opcode: "sensing_setdragmode" }, blockly),
    new BOMBlock({ opcode: "sensing_timer" }, blockly),
    new BOMBlock({ opcode: "sensing_touchingcolor" }, blockly),
    new BOMBlock({ opcode: "sensing_touchingobject" }, blockly),
    // new BOMBlock({ opcode: "sensing_touchingobjectmenu" }, blockly),
    new BOMBlock({ opcode: "sensing_userid" }, blockly),
    new BOMBlock({ opcode: "sensing_username" }, blockly),
    // new BOMBlock({ opcode: "sound" }, blockly),
    new BOMBlock({ opcode: "sound_changeeffectby" }, blockly),
    new BOMBlock({ opcode: "sound_changevolumeby" }, blockly),
    new BOMBlock({ opcode: "sound_cleareffects" }, blockly),
    new BOMBlock({ opcode: "sound_play" }, blockly),
    new BOMBlock({ opcode: "sound_playuntildone" }, blockly),
    new BOMBlock({ opcode: "sound_seteffectto", bid: "SOUND_SETEFFECTO" }, blockly),
    new BOMBlock({ opcode: "sound_setvolumeto" }, blockly),
    // new BOMBlock({ opcode: "sound_sounds_menu" }, blockly),
    new BOMBlock({ opcode: "sound_stopallsounds" }, blockly),
    new BOMBlock({ opcode: "sound_volume" }, blockly),
    // new BOMBlock({ opcode: "text" }, blockly),
    // new BOMBlock({ opcode: "texts" }, blockly),
  ].forEach((block) => (map[block.opcode] = block));
}
