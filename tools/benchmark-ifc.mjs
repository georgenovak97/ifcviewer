#!/usr/bin/env node
/**
 * Phase benchmark for IFC conversion.
 * Usage: benchmark-ifc.mjs -s model.ifc
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebIFC from 'web-ifc';
import { XKTModel } from '@xeokit/xeokit-convert';
import { parseIFCFast } from './lib/parseIFCFast.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPath = join(resolve(__dirname, 'node_modules/web-ifc'), '/');

const source = process.argv[process.argv.indexOf('-s') + 1];
if (!source) {
	console.error('Usage: benchmark-ifc.mjs -s <input.ifc>');
	process.exit(1);
}

const data = readFileSync(source);
const xktModel = new XKTModel({ minTileSize: 5000 });
const stats = {};

const start = Date.now();
await parseIFCFast({
	WebIFC,
	data,
	xktModel,
	wasmPath,
	externalMetadata: true,
	stats,
	log: (msg) => console.log('[bench] ' + msg),
});

console.log('Total: ' + ((Date.now() - start) / 1000).toFixed(1) + ' s');
console.log(JSON.stringify(stats, null, 2));
