#!/usr/bin/env node
/**
 * Optimized IFC → XKT converter for ifcviewer (fast flat property parsing).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeExternalMetadata } from './lib/writeExternalMetadata.mjs';
import WebIFC from 'web-ifc';
import { XKTModel, writeXKTModelToArrayBuffer } from '@xeokit/xeokit-convert';
import { parseIFCFast, DEFAULT_EXCLUDE_GEOMETRY_TYPES } from './lib/parseIFCFast.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPath = join(resolve(__dirname, 'node_modules/web-ifc'), '/');

function log(msg) {
	if (process.argv.includes('-l') || process.argv.includes('--log')) {
		console.log('[convert-ifc] ' + msg);
	}
}

function validateIfcSource(source, data) {
	if (!data || data.byteLength < 32) {
		throw new Error('IFC file is empty or too small');
	}
	const head = new TextDecoder('utf-8', { fatal: false }).decode(data.slice(0, 4096));
	if (!head.includes('ISO-10303-21')) {
		throw new Error('File is not a valid IFC (ISO-10303-21 header missing)');
	}
	const schemaMatch = head.match(/FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i);
	if (schemaMatch) {
		log('Detected schema: ' + schemaMatch[1]);
	}
}

function parseArgs(argv) {
	const args = {
		source: null,
		output: null,
		minTileSize: 5000,
		zip: true,
		externalMetadata: true,
		excludeGeometryTypes: [...DEFAULT_EXCLUDE_GEOMETRY_TYPES],
	};
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '-s' || arg === '--source') {
			args.source = argv[++i];
		} else if (arg === '-o' || arg === '--output') {
			args.output = argv[++i];
		} else if (arg === '-z' || arg === '--minTileSize') {
			args.minTileSize = Number(argv[++i]);
		} else if (arg === '--no-zip') {
			args.zip = false;
		} else if (arg === '-m' || arg === '--external-metadata') {
			args.externalMetadata = true;
		} else if (arg === '--inline-metadata') {
			args.externalMetadata = false;
		} else if (arg === '--exclude-geometry') {
			args.excludeGeometryTypes = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
		}
	}
	return args;
}

async function convertIfc({
	source,
	output,
	minTileSize,
	zip,
	externalMetadata,
	excludeGeometryTypes,
}) {
	const startTime = Date.now();
	const sourceData = readFileSync(source);
	const sourceFileSizeBytes = sourceData.byteLength;
	validateIfcSource(source, sourceData);
	const xktModel = new XKTModel({ minTileSize });
	const stats = {};

	log('Converting ' + source + ' ...');

	await parseIFCFast({
		WebIFC,
		data: sourceData,
		xktModel,
		wasmPath,
		autoNormals: true,
		externalMetadata,
		excludeGeometryTypes,
		stats,
		log,
	});

	log('Finalizing XKT...');
	await xktModel.finalize();

	const xktArrayBuffer = writeXKTModelToArrayBuffer(xktModel, null, stats, { zip });
	writeFileSync(output, Buffer.from(xktArrayBuffer));

	if (stats.numObjects === 0) {
		throw new Error('No drawable objects were produced from this IFC file');
	}

	if (externalMetadata && stats.externalMetadata) {
		writeExternalMetadata(output, stats.externalMetadata, log);
	}

	const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
	log('Converted metaobjects: ' + stats.numMetaObjects);
	log('Converted property sets: ' + stats.numPropertySets);
	log('Converted drawable objects: ' + stats.numObjects);
	log('Converted geometries: ' + stats.numGeometries);
	if (stats.schemaVersion) {
		log('Schema: ' + stats.schemaVersion);
	}
	log('Converted triangles: ' + stats.numTriangles);
	log('Converted vertices: ' + stats.numVertices);
	log('Converted tiles: ' + xktModel.tilesList.length);
	log('XKT size: ' + (xktArrayBuffer.byteLength / 1024).toFixed(1) + ' kB');
	log('Source size: ' + (sourceFileSizeBytes / 1024 / 1024).toFixed(2) + ' MB');
	log('Conversion time: ' + elapsed + ' s');
	log('Writing XKT file: ' + output);
	log('Done.');
}

const args = parseArgs(process.argv);
if (!args.source || !args.output) {
	console.error('Usage: convert-ifc.mjs -s <input.ifc> -o <output.xkt> [-l] [-z 5000] [-m]');
	process.exit(1);
}

convertIfc(args).catch((err) => {
	console.error('[convert-ifc] ERROR: ' + (err?.message || err));
	process.exit(1);
});
