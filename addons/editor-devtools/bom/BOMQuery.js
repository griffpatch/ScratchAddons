import BOMProject from "./BOMProject";

export default class BOMQuery {
  constructor(addon) {
    /**
     * @type {VirtualMachine}
     */
    this.vm = addon.tab.traps.vm;
    // this.project = new BOMProject(vm);
  }
}
