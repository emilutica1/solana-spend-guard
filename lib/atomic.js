'use strict';
const fs = require('fs');
const path = require('path');

// Write to a temporary file, fsync it, then rename it over the target. A rename inside one directory is atomic, so a
// crash or power loss mid-write leaves either the old file or the new one, never an empty or half-written file.
function writeFileAtomicSync(target, data) {
  const rand = Math.random().toString(36).slice(2, 10);
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.${rand}.tmp`);
  try {
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
  try {   // make the rename itself durable; not supported on every filesystem
    const dfd = fs.openSync(path.dirname(target), 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch { /* best effort */ }
}

module.exports = { writeFileAtomicSync };
