#!/usr/bin/env node
'use strict';

/**
 * Entry point for NGINX Unit (GO54 / DirectAdmin "Nginx Unit" hosting).
 *
 * Unit runs Node apps by rewiring the `http` module through its unit-http
 * loader; requiring the loader first lets src/server.js — an ordinary Express
 * app — speak Unit's protocol with no other changes. In the DirectAdmin NodeJS
 * template: working directory = this repository root, script = unit-start.js
 * (run `chmod +x unit-start.js` — Unit starts the file itself).
 */
require('unit-http/loader');

require('./src/server').start().catch((error) => {
  console.error('Failed to start:', error);
  process.exit(1);
});
