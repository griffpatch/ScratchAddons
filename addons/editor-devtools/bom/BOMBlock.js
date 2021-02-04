export class BOMBlock {
  /**
   * @param param {{opcode:string, [bid]:string, [deprecated]:boolean}}
   * @param blockly {Blockly}
   */
  constructor(param, blockly) {
    this.opcode = param.opcode;
    /**
     * Blockly Msg ID
     * @type {string|*|string}
     */
    this.bid = param.bid ? param.bid : param.opcode.toUpperCase();
    this.msg = this.sanitiseMsg(blockly, this.bid);
    if (this.msg) {
      console.log(this.msg);
    } else {
      console.error(this.bid);
    }
    this.deprecated = param.deprecated;
  }

  sanitiseMsg(blockly, bid, nested) {
    if (!bid) {
      return "";
    }

    if (bid instanceof Array) {
      let sanitise = "";
      for (const bidElement of bid) {
        let sanitiseMsg = this.sanitiseMsg(blockly, bidElement, true);
        sanitise =
          sanitiseMsg.length > 0 ? (sanitise.length > 0 ? sanitise + " " + sanitiseMsg : sanitiseMsg) : sanitise;
        if (nested) {
          // Testing - just first for now please
          break;
        }
      }
      return sanitise;
    }

    let msg = blockly.Msg[bid];
    return msg.replace(/%\d/g, "()");
  }
}
