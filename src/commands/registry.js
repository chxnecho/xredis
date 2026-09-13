'use strict';

// Command metadata + registry.
//
// Each command entry:
//   arity:  exact number of arguments (negative = minimum)
//   flags:  subset of 'write' | 'readonly' | 'admin' | 'pubsub' | 'denyoom'
//   firstKey:  index of first key arg (-1 = no key)
//   lastKey:   index of last key arg (-1 = same as firstKey)
//   keyStep:   step between keys
//   handler: (server, argv, ctx) => encoded reply Buffer
//   aofArgv: optional (argv, now) => argv to write to AOF for propagation

const { arity } = require('../util');

class Command {
  constructor(name, spec) {
    this.name = name.toLowerCase();
    this.arity = spec.arity || 0;
    this.flags = spec.flags || ['readonly'];
    this.firstKey = spec.firstKey === undefined ? -1 : spec.firstKey;
    this.lastKey = spec.lastKey === undefined ? this.firstKey : spec.lastKey;
    this.keyStep = spec.keyStep === undefined ? 1 : spec.keyStep;
    this.handler = spec.handler;
    this.aofArgv = spec.aofArgv || null;
  }

  get write() { return this.flags.includes('write'); }
  get readonly() { return this.flags.includes('readonly'); }
  get admin() { return this.flags.includes('admin'); }
  get pubsub() { return this.flags.includes('pubsub'); }
  get denyOom() { return this.flags.includes('denyoom'); }

  checkArity(argv) {
    const n = argv.length;
    if (this.arity >= 0 ? n !== this.arity : n < -this.arity) {
      throw arity(this.name);
    }
  }
}

module.exports = { Command };