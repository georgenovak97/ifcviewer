/**
 * Fast IFC parser for ifcviewer.
 * Optimized for large models: indexed spatial tree, streamed geometry, flat property parsing.
 */

/**
 * Tuned for Revit IFC2x3 Coordination View 2.0 exports:
 * triangulated geometry, no rooms/spaces, StoreIFCGUID=true, low LOD.
 */
const IFC_LOADER_SETTINGS = {
	COORDINATE_TO_ORIGIN: true,
	CIRCLE_SEGMENTS: 4,
	BOOLEAN_UNION_THRESHOLD: 100,
	MEMORY_LIMIT: 2 * 1024 * 1024 * 1024,
};

const DEFAULT_EXCLUDE_GEOMETRY_TYPES = [
	'IfcSpace',
	'IfcOpeningElement',
	'IfcOpeningStandardCase',
	'IfcGrid',
	'IfcAnnotation',
	'IfcFeatureElementSubtraction',
	'IfcVirtualElement',
	'IfcFastener',
	'IfcMechanicalFastener',
	'IfcDiscreteAccessory',
];

/** Keep explorer tree aligned with Revit CV 2.0 (no rooms/openings in tree). */
const DEFAULT_EXCLUDE_META_TYPES = [
	...DEFAULT_EXCLUDE_GEOMETRY_TYPES,
];

const EXCLUDE_GEOMETRY_TYPE_KEYS = new Set(
	DEFAULT_EXCLUDE_GEOMETRY_TYPES.map((name) => name.toUpperCase()),
);

function asHandleList(handles) {
	if (!handles) {
		return [];
	}
	return Array.isArray(handles) ? handles : [handles];
}

function extractPropertyValue(ifcAPI, modelID, propLine) {
	const name = propLine?.Name?.value;
	if (!name) {
		return null;
	}

	if (propLine.EnumerationValues?.length) {
		const values = [];
		for (const entry of propLine.EnumerationValues) {
			if (entry?.value !== undefined && entry?.value !== null) {
				values.push(entry.value);
			}
		}
		if (values.length) {
			return {
				name,
				type: propLine.type || 'IfcPropertyEnumeratedValue',
				value: values.join(', '),
			};
		}
	}

	let nominalValue = propLine.NominalValue;
	if (!nominalValue) {
		return null;
	}

	if (nominalValue.value !== undefined && nominalValue.type === undefined) {
		const valueLine = ifcAPI.GetLine(modelID, nominalValue.value, false);
		if (valueLine) {
			nominalValue = valueLine;
		}
	}

	const value = nominalValue.value;
	if (value === undefined || value === null) {
		return null;
	}
	if (typeof value === 'string' && value.trim() === '') {
		return null;
	}

	const property = {
		name,
		type: nominalValue.type,
		value,
		valueType: nominalValue.valueType,
	};
	if (propLine.Description?.value) {
		property.description = propLine.Description.value;
	} else if (nominalValue.description) {
		property.description = nominalValue.description;
	}
	return property;
}

function extractPropertiesFromDefinition(ifcAPI, modelID, definition) {
	const properties = [];

	const props = definition?.HasProperties;
	for (const propHandle of asHandleList(props)) {
		const propLine = ifcAPI.GetLine(modelID, propHandle?.value, false);
		const property = extractPropertyValue(ifcAPI, modelID, propLine);
		if (property) {
			properties.push(property);
		}
	}

	const quantities = definition?.Quantities;
	for (const quantityHandle of asHandleList(quantities)) {
		const quantityLine = ifcAPI.GetLine(modelID, quantityHandle?.value, false);
		const name = quantityLine?.Name?.value;
		if (!name) {
			continue;
		}
		const value = quantityLine?.LengthValue?.value
			?? quantityLine?.AreaValue?.value
			?? quantityLine?.VolumeValue?.value
			?? quantityLine?.CountValue?.value
			?? quantityLine?.WeightValue?.value
			?? quantityLine?.TimeValue?.value;
		if (value === undefined || value === null) {
			continue;
		}
		properties.push({
			name,
			type: quantityLine.type,
			value,
		});
	}

	return properties;
}

function storePropertySet(ctx, propertySetId, propertySetName, properties) {
	if (ctx.externalMetadata) {
		ctx.externalMetadata.propertySets[propertySetId] = {
			propertySetId,
			propertySetName,
			properties,
		};
		return;
	}

	ctx.xktModel.createPropertySet({
		propertySetId,
		propertySetType: 'Default',
		propertySetName,
		properties,
	});
}

function propertySetExists(ctx, propertySetId) {
	if (ctx.externalMetadata?.propertySets?.[propertySetId]) {
		return true;
	}
	return !!ctx.xktModel.propertySets?.[propertySetId];
}

const REVIT_PROPERTY_SET_ORDER = [
	'Materials and Finishes',
	'Materials',
	'Constraints',
	'Dimensions',
	'Identity Data',
	'Other',
	'Phasing',
	'Structural',
	'Rebar Set',
	'Text',
	'Graphics',
	'Construction',
	'Analytical Properties',
	'Analytical',
	'Electrical',
	'Energy Analysis',
	'Mechanical',
	'Plumbing',
	'Fire Protection',
	'Vertical Circulation',
	'Data',
	'Overall Legend',
];

const PROPERTY_SET_SOURCE_RANK = {
	'revit-instance': 1,
	'revit-type': 2,
	'ifc-material': 3,
	'ifc-element': 4,
	'ifc-other': 5,
};

function isRevitMaterialPropertySetName(propertySetName) {
	const name = String(propertySetName || '').trim();
	if (name === 'Materials') {
		return true;
	}
	return /^Materials and Finishes(?:\s*\(Type\))?$/i.test(name);
}

function shouldReplacePropertySetSource(currentSource, nextSource) {
	if (!currentSource) {
		return true;
	}
	const currentRank = PROPERTY_SET_SOURCE_RANK[currentSource] ?? 99;
	const nextRank = PROPERTY_SET_SOURCE_RANK[nextSource] ?? 99;
	return nextRank < currentRank;
}

function recordPropertySetSource(ctx, metaObjectId, propertySetId, source) {
	if (!ctx.externalMetadata) {
		return;
	}
	if (!ctx.externalMetadata.objectPropertySetSources) {
		ctx.externalMetadata.objectPropertySetSources = {};
	}
	if (!ctx.externalMetadata.objectPropertySetSources[metaObjectId]) {
		ctx.externalMetadata.objectPropertySetSources[metaObjectId] = {};
	}
	const sources = ctx.externalMetadata.objectPropertySetSources[metaObjectId];
	if (shouldReplacePropertySetSource(sources[propertySetId], source)) {
		sources[propertySetId] = source;
	}
}

function getPropertySetDisplayName(ctx, propertySetId) {
	const raw = ctx.externalMetadata?.propertySets?.[propertySetId];
	return raw?.propertySetName || propertySetId;
}

function normalizePropertySetName(name) {
	return String(name || '').trim().toLowerCase();
}

function propertySetFingerprintFromId(ctx, propertySetId) {
	const raw = ctx.externalMetadata?.propertySets?.[propertySetId];
	if (!raw) {
		return propertySetId;
	}
	const name = normalizePropertySetName(raw.propertySetName);
	const props = (raw.properties || [])
		.map((property) => `${property.name ?? ''}\u0000${property.value ?? ''}`)
		.sort()
		.join('\u0001');
	return `${name}\u0002${props}`;
}

function unlinkPropertySetFromObject(ctx, metaObjectId, propertySetId) {
	const metaObject = ctx.xktModel.metaObjects[metaObjectId];
	if (metaObject?.propertySetIds) {
		metaObject.propertySetIds = metaObject.propertySetIds.filter((id) => id !== propertySetId);
	}
	if (!ctx.externalMetadata) {
		return;
	}
	const objectSets = ctx.externalMetadata.objectPropertySets?.[metaObjectId];
	if (objectSets) {
		ctx.externalMetadata.objectPropertySets[metaObjectId] = objectSets.filter((id) => id !== propertySetId);
	}
	const sources = ctx.externalMetadata.objectPropertySetSources?.[metaObjectId];
	if (sources) {
		delete sources[propertySetId];
	}
}

function shouldLinkPropertySetToObject(ctx, metaObjectId, propertySetId, source) {
	const linkedIds = getLinkedPropertySetIds(ctx, metaObjectId);
	const fingerprint = propertySetFingerprintFromId(ctx, propertySetId);

	for (const existingId of linkedIds) {
		if (existingId === propertySetId) {
			return true;
		}
		if (propertySetFingerprintFromId(ctx, existingId) !== fingerprint) {
			continue;
		}
		const existingSource = ctx.externalMetadata?.objectPropertySetSources?.[metaObjectId]?.[existingId] || 'ifc-other';
		if (shouldReplacePropertySetSource(existingSource, source)) {
			unlinkPropertySetFromObject(ctx, metaObjectId, existingId);
			continue;
		}
		return false;
	}

	return true;
}

function linkPropertySetToObject(ctx, metaObjectId, propertySetId, source = 'ifc-other') {
	if (!propertySetExists(ctx, propertySetId)) {
		return;
	}
	if (!shouldLinkPropertySetToObject(ctx, metaObjectId, propertySetId, source)) {
		return;
	}

	const metaObject = ctx.xktModel.metaObjects[metaObjectId];
	if (metaObject) {
		if (!metaObject.propertySetIds) {
			metaObject.propertySetIds = [];
		}
		if (!metaObject.propertySetIds.includes(propertySetId)) {
			metaObject.propertySetIds.push(propertySetId);
		}
	}

	if (ctx.externalMetadata) {
		if (!ctx.externalMetadata.objectPropertySets[metaObjectId]) {
			ctx.externalMetadata.objectPropertySets[metaObjectId] = [];
		}
		const objectSets = ctx.externalMetadata.objectPropertySets[metaObjectId];
		if (!objectSets.includes(propertySetId)) {
			objectSets.push(propertySetId);
		}
		recordPropertySetSource(ctx, metaObjectId, propertySetId, source);
	}
}

function getLinkedPropertySetIds(ctx, metaObjectId) {
	if (ctx.externalMetadata?.objectPropertySets?.[metaObjectId]) {
		return ctx.externalMetadata.objectPropertySets[metaObjectId];
	}
	return ctx.xktModel.metaObjects[metaObjectId]?.propertySetIds || [];
}

function storeElementAttributesPropertySet(ctx, ifcElement) {
	const metaObjectId = ifcElement?.GlobalId?.value;
	if (!metaObjectId) {
		return;
	}

	const properties = [];
	const add = (name, value) => {
		if (value === undefined || value === null) {
			return;
		}
		const text = String(value).trim();
		if (!text) {
			return;
		}
		properties.push({
			name,
			type: 'IfcText',
			value: text,
		});
	};

	add('ObjectType', ifcElement.ObjectType?.value);
	add('Tag', ifcElement.Tag?.value);
	add('Description', ifcElement.Description?.value);
	add('PredefinedType', ifcElement.PredefinedType?.value);

	if (!properties.length) {
		return;
	}

	const propertySetId = metaObjectId + ':attrs';
	if (!ctx.attributePropertySetIds) {
		ctx.attributePropertySetIds = new Set();
	}
	if (!ctx.attributePropertySetIds.has(propertySetId)) {
		storePropertySet(ctx, propertySetId, 'IFC Element', properties);
		ctx.attributePropertySetIds.add(propertySetId);
		ctx.stats.numPropertySets++;
	}
	linkPropertySetToObject(ctx, metaObjectId, propertySetId, 'ifc-element');
}

function linkHasPropertySetsFromElement(ctx, elementLine, createdPropertySets) {
	const metaObjectId = elementLine?.GlobalId?.value;
	if (!metaObjectId) {
		return;
	}

	for (const handle of asHandleList(elementLine?.HasPropertySets)) {
		const expressId = handle?.value;
		if (!expressId) {
			continue;
		}
		const propertySetLine = ctx.ifcAPI.GetLine(ctx.modelID, expressId, false);
		const propertySetId = propertySetLine?.GlobalId?.value;
		if (!propertySetId || !createdPropertySets.has(propertySetId)) {
			continue;
		}
		linkPropertySetToObject(ctx, metaObjectId, propertySetId, 'revit-type');
	}
}

function parseTypeEmbeddedPropertySets(ctx, createdPropertySets) {
	const { ifcAPI, modelID, WebIFC } = ctx;

	for (const key of Object.keys(WebIFC)) {
		if (!key.startsWith('IFC') || !key.endsWith('TYPE')) {
			continue;
		}
		const typeId = WebIFC[key];
		if (typeof typeId !== 'number') {
			continue;
		}

		let typeLines;
		try {
			typeLines = ifcAPI.GetLineIDsWithType(modelID, typeId);
		} catch {
			continue;
		}

		for (let i = 0; i < typeLines.size(); i++) {
			const typeLine = ifcAPI.GetLine(modelID, typeLines.get(i), false);
			linkHasPropertySetsFromElement(ctx, typeLine, createdPropertySets);
		}
	}
}

function resolveMaterialNames(ctx, materialExpressId, visited = new Set()) {
	if (!materialExpressId || visited.has(materialExpressId)) {
		return [];
	}
	visited.add(materialExpressId);

	const { ifcAPI, modelID, WebIFC } = ctx;
	const line = ifcAPI.GetLine(modelID, materialExpressId, false);
	if (!line) {
		return [];
	}

	if (line.type === WebIFC.IFCMATERIAL) {
		const name = line.Name?.value;
		return name ? [String(name)] : [];
	}

	if (line.type === WebIFC.IFCMATERIALLIST) {
		const names = [];
		for (const handle of asHandleList(line.Materials)) {
			names.push(...resolveMaterialNames(ctx, handle?.value, visited));
		}
		return names;
	}

	if (line.type === WebIFC.IFCMATERIALLAYERSET) {
		const names = [];
		const layerSetName = line.LayerSetName?.value;
		if (layerSetName) {
			names.push(String(layerSetName));
		}
		for (const handle of asHandleList(line.MaterialLayers)) {
			const layer = ifcAPI.GetLine(modelID, handle?.value, false);
			names.push(...resolveMaterialNames(ctx, layer?.Material?.value, visited));
		}
		return names;
	}

	if (line.type === WebIFC.IFCMATERIALLAYERSETUSAGE) {
		return resolveMaterialNames(ctx, line.ForLayerSet?.value, visited);
	}

	if (line.type === WebIFC.IFCMATERIALLAYER) {
		return resolveMaterialNames(ctx, line.Material?.value, visited);
	}

	return [];
}

function uniqueNonEmptyStrings(values) {
	const seen = new Set();
	const result = [];
	for (const value of values) {
		const text = String(value).trim();
		if (!text || seen.has(text)) {
			continue;
		}
		seen.add(text);
		result.push(text);
	}
	return result;
}

function storeMaterialPropertySet(ctx, metaObjectId, materialNames) {
	const names = uniqueNonEmptyStrings(materialNames);
	if (!names.length) {
		return;
	}

	const propertySetId = metaObjectId + ':ifc-material';
	if (!ctx.materialPropertySetIds) {
		ctx.materialPropertySetIds = new Set();
	}

	const properties = names.map((name, index) => ({
		name: names.length === 1 ? 'Material' : `Material ${index + 1}`,
		type: 'IfcLabel',
		value: name,
	}));

	if (!ctx.materialPropertySetIds.has(propertySetId)) {
		storePropertySet(ctx, propertySetId, 'Materials', properties);
		ctx.materialPropertySetIds.add(propertySetId);
		ctx.stats.numPropertySets++;
	} else if (ctx.externalMetadata) {
		ctx.externalMetadata.propertySets[propertySetId].properties = properties;
	}

	linkPropertySetToObject(ctx, metaObjectId, propertySetId, 'ifc-material');
}

function parseMaterialAssociations(ctx) {
	const { ifcAPI, modelID, WebIFC } = ctx;
	const relLines = ifcAPI.GetLineIDsWithType(modelID, WebIFC.IFCRELASSOCIATESMATERIAL);
	for (let i = 0; i < relLines.size(); i++) {
		const rel = ifcAPI.GetLine(modelID, relLines.get(i), false);
		const materialNames = resolveMaterialNames(ctx, rel?.RelatingMaterial?.value);
		if (!materialNames.length) {
			continue;
		}

		for (const relatedObject of asHandleList(rel.RelatedObjects)) {
			const expressId = relatedObject?.value;
			if (!expressId) {
				continue;
			}
			const relatedLine = ifcAPI.GetLine(modelID, expressId, false);
			const metaObjectId = relatedLine?.GlobalId?.value;
			if (!metaObjectId) {
				continue;
			}
			storeMaterialPropertySet(ctx, metaObjectId, materialNames);
		}
	}
}

function parsePropertySetsFast(ctx) {
	const { ifcAPI, modelID, WebIFC, stats } = ctx;
	const createdPropertySets = new Set();

	const psetLines = ifcAPI.GetLineIDsWithType(modelID, WebIFC.IFCPROPERTYSET);
	for (let i = 0; i < psetLines.size(); i++) {
		const pset = ifcAPI.GetLine(modelID, psetLines.get(i), false);
		const propertySetId = pset?.GlobalId?.value;
		if (!propertySetId || createdPropertySets.has(propertySetId)) {
			continue;
		}
		const properties = extractPropertiesFromDefinition(ifcAPI, modelID, pset);
		if (!properties.length) {
			continue;
		}
		storePropertySet(ctx, propertySetId, pset.Name?.value || propertySetId, properties);
		createdPropertySets.add(propertySetId);
		stats.numPropertySets++;
	}

	const quantityLines = ifcAPI.GetLineIDsWithType(modelID, WebIFC.IFCELEMENTQUANTITY);
	for (let i = 0; i < quantityLines.size(); i++) {
		const quantitySet = ifcAPI.GetLine(modelID, quantityLines.get(i), false);
		const propertySetId = quantitySet?.GlobalId?.value;
		if (!propertySetId || createdPropertySets.has(propertySetId)) {
			continue;
		}
		const properties = extractPropertiesFromDefinition(ifcAPI, modelID, quantitySet);
		if (!properties.length) {
			continue;
		}
		storePropertySet(ctx, propertySetId, quantitySet.Name?.value || propertySetId, properties);
		createdPropertySets.add(propertySetId);
		stats.numPropertySets++;
	}

	parseTypeEmbeddedPropertySets(ctx, createdPropertySets);

	const relLines = ifcAPI.GetLineIDsWithType(modelID, WebIFC.IFCRELDEFINESBYPROPERTIES);
	for (let i = 0; i < relLines.size(); i++) {
		const rel = ifcAPI.GetLine(modelID, relLines.get(i), false);
		const definitionExpressId = rel?.RelatingPropertyDefinition?.value;
		if (!definitionExpressId) {
			continue;
		}
		const definition = ifcAPI.GetLine(modelID, definitionExpressId, false);
		const propertySetId = definition?.GlobalId?.value;
		if (!propertySetId) {
			continue;
		}

		if (!createdPropertySets.has(propertySetId)) {
			const properties = extractPropertiesFromDefinition(ifcAPI, modelID, definition);
			if (properties.length) {
				storePropertySet(ctx, propertySetId, definition.Name?.value || propertySetId, properties);
				createdPropertySets.add(propertySetId);
				stats.numPropertySets++;
			}
		}

		if (!createdPropertySets.has(propertySetId)) {
			continue;
		}

		const relatedObjects = rel.RelatedObjects;
		for (const relatedObject of asHandleList(relatedObjects)) {
			const expressId = relatedObject?.value;
			if (!expressId) {
				continue;
			}
			const relatedLine = ifcAPI.GetLine(modelID, expressId, false);
			const metaObjectId = relatedLine?.GlobalId?.value;
			if (!metaObjectId) {
				continue;
			}
			linkPropertySetToObject(ctx, metaObjectId, propertySetId, 'revit-instance');
		}
	}

	const typeRelLines = ifcAPI.GetLineIDsWithType(modelID, WebIFC.IFCRELDEFINESBYTYPE);
	for (let i = 0; i < typeRelLines.size(); i++) {
		const rel = ifcAPI.GetLine(modelID, typeRelLines.get(i), false);
		const typeExpressId = rel?.RelatingType?.value;
		if (!typeExpressId) {
			continue;
		}
		const typeLine = ifcAPI.GetLine(modelID, typeExpressId, false);
		const typeGlobalId = typeLine?.GlobalId?.value;
		if (!typeGlobalId) {
			continue;
		}
		const typePropertySetIds = getLinkedPropertySetIds(ctx, typeGlobalId)
			.filter((propertySetId) => propertySetExists(ctx, propertySetId));
		if (!typePropertySetIds.length) {
			continue;
		}

		for (const relatedObject of asHandleList(rel.RelatedObjects)) {
			const expressId = relatedObject?.value;
			if (!expressId) {
				continue;
			}
			const relatedLine = ifcAPI.GetLine(modelID, expressId, false);
			const metaObjectId = relatedLine?.GlobalId?.value;
			if (!metaObjectId) {
				continue;
			}
			for (const propertySetId of typePropertySetIds) {
				linkPropertySetToObject(ctx, metaObjectId, propertySetId, 'revit-type');
			}
		}
	}

	parseMaterialAssociations(ctx);
}

function buildStreamTypeIds(ctx) {
	const { WebIFC, ifcAPI, excludeGeometryTypes } = ctx;
	const excludeKeys = new Set(EXCLUDE_GEOMETRY_TYPE_KEYS);
	if (excludeGeometryTypes) {
		for (const name of Object.keys(excludeGeometryTypes)) {
			excludeKeys.add(name.toUpperCase());
		}
	}
	const types = [];

	for (const key of Object.keys(WebIFC)) {
		if (!key.startsWith('IFC') || excludeKeys.has(key)) {
			continue;
		}
		const typeId = WebIFC[key];
		if (typeof typeId !== 'number') {
			continue;
		}
		try {
			if (ifcAPI.IsIfcElement(typeId)) {
				types.push(typeId);
			}
		} catch {
			// skip invalid type ids
		}
	}

	return types;
}

function buildRelationshipIndexes(ctx) {
	const aggregatesChildren = new Map();
	const spatialChildren = new Map();

	const aggregateLines = ctx.ifcAPI.GetLineIDsWithType(ctx.modelID, ctx.WebIFC.IFCRELAGGREGATES);
	for (let i = 0; i < aggregateLines.size(); i++) {
		const rel = ctx.ifcAPI.GetLine(ctx.modelID, aggregateLines.get(i), false);
		const parentId = rel?.RelatingObject?.value;
		if (!parentId) {
			continue;
		}
		pushChildren(aggregatesChildren, parentId, rel.RelatedObjects);
	}

	const spatialLines = ctx.ifcAPI.GetLineIDsWithType(ctx.modelID, ctx.WebIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE);
	for (let i = 0; i < spatialLines.size(); i++) {
		const rel = ctx.ifcAPI.GetLine(ctx.modelID, spatialLines.get(i), false);
		const parentId = rel?.RelatingStructure?.value;
		if (!parentId) {
			continue;
		}
		pushChildren(spatialChildren, parentId, rel.RelatedElements);
	}

	ctx.aggregatesChildren = aggregatesChildren;
	ctx.spatialChildren = spatialChildren;
}

function pushChildren(index, parentId, related) {
	if (!related) {
		return;
	}
	if (!index.has(parentId)) {
		index.set(parentId, []);
	}
	const bucket = index.get(parentId);
	const list = Array.isArray(related) ? related : [related];
	for (const item of list) {
		if (item?.value) {
			bucket.push(item.value);
		}
	}
}

function getIfcTypeName(ifcElement) {
	return ifcElement?.__proto__?.constructor?.name || 'IfcElement';
}

function shouldIncludeMetaObject(ctx, metaObjectType) {
	if (ctx.includeTypes && !ctx.includeTypes[metaObjectType]) {
		return false;
	}
	if (ctx.excludeTypes && ctx.excludeTypes[metaObjectType]) {
		return false;
	}
	return true;
}

function shouldIncludeGeometry(ctx, metaObjectType) {
	if (!shouldIncludeMetaObject(ctx, metaObjectType)) {
		return false;
	}
	if (ctx.excludeGeometryTypes && ctx.excludeGeometryTypes[metaObjectType]) {
		return false;
	}
	return true;
}

function createMetaObject(ctx, ifcElement, parentMetaObjectId) {
	const metaObjectId = ifcElement.GlobalId.value;
	const metaObjectType = getIfcTypeName(ifcElement);
	const metaObjectName = (ifcElement.Name && ifcElement.Name.value !== '')
		? ifcElement.Name.value
		: metaObjectType;

	ctx.xktModel.createMetaObject({
		metaObjectId,
		propertySetIds: null,
		metaObjectType,
		metaObjectName,
		parentMetaObjectId,
	});
	ctx.stats.numMetaObjects++;
	ctx.expressTypeByGuid.set(metaObjectId, metaObjectType);
	storeElementAttributesPropertySet(ctx, ifcElement);
}

function walkSpatialNode(ctx, expressId, parentMetaObjectId) {
	if (ctx.visitedExpressIds.has(expressId)) {
		return;
	}
	ctx.visitedExpressIds.add(expressId);

	const ifcElement = ctx.ifcAPI.GetLine(ctx.modelID, expressId, false);
	if (!ifcElement?.GlobalId?.value) {
		return;
	}

	const metaObjectType = getIfcTypeName(ifcElement);
	if (!shouldIncludeMetaObject(ctx, metaObjectType)) {
		return;
	}

	createMetaObject(ctx, ifcElement, parentMetaObjectId);
	const metaObjectId = ifcElement.GlobalId.value;

	const aggregateKids = ctx.aggregatesChildren.get(expressId);
	if (aggregateKids) {
		for (const childExpressId of aggregateKids) {
			walkSpatialNode(ctx, childExpressId, metaObjectId);
		}
	}

	const spatialKids = ctx.spatialChildren.get(expressId);
	if (spatialKids) {
		for (const childExpressId of spatialKids) {
			walkSpatialNode(ctx, childExpressId, metaObjectId);
		}
	}
}

function parseMetadata(ctx) {
	buildRelationshipIndexes(ctx);
	ctx.visitedExpressIds = new Set();

	const projectLines = ctx.ifcAPI.GetLineIDsWithType(ctx.modelID, ctx.WebIFC.IFCPROJECT);
	const ifcProjectId = projectLines.get(0);
	walkSpatialNode(ctx, ifcProjectId, null);
}

function parseGeometry(ctx) {
	const streamTypes = buildStreamTypeIds(ctx);
	ctx.log('Streaming geometry for ' + streamTypes.length + ' element types...');

	let lastLog = 0;
	ctx.ifcAPI.StreamAllMeshesWithTypes(ctx.modelID, streamTypes, (flatMesh, index, total) => {
		if (index - lastLog >= 1000) {
			ctx.log('Geometry progress: ' + index + '/' + total);
			lastLog = index;
		}
		createObject(ctx, flatMesh);
		if (typeof flatMesh.delete === 'function') {
			flatMesh.delete();
		}
	});
}

function isNearWhiteColor(rgb) {
	return rgb[0] > 0.95 && rgb[1] > 0.95 && rgb[2] > 0.95;
}

function extractIfcNumber(prop) {
	if (prop === null || prop === undefined) {
		return null;
	}
	if (typeof prop === 'number') {
		return prop;
	}
	if (prop.value !== undefined && typeof prop.value === 'number') {
		return prop.value;
	}
	if (prop._representationValue !== undefined) {
		return prop._representationValue;
	}
	return null;
}

function buildStyledColorIndex(ctx) {
	const { ifcAPI, modelID, WebIFC } = ctx;
	const colorByExpressId = new Map();

	const colourById = new Map();
	const colourLines = ifcAPI.GetLineIDsWithType(modelID, WebIFC.IFCCOLOURRGB);
	for (let i = 0; i < colourLines.size(); i++) {
		const expressId = colourLines.get(i);
		const line = ifcAPI.GetLine(modelID, expressId, false);
		const red = extractIfcNumber(line?.Red);
		const green = extractIfcNumber(line?.Green);
		const blue = extractIfcNumber(line?.Blue);
		if (red === null || green === null || blue === null) {
			continue;
		}
		colourById.set(expressId, [red, green, blue]);
	}

	const renderingColorById = new Map();
	const renderingLines = ifcAPI.GetLineIDsWithType(modelID, WebIFC.IFCSURFACESTYLERENDERING);
	for (let i = 0; i < renderingLines.size(); i++) {
		const expressId = renderingLines.get(i);
		const line = ifcAPI.GetLine(modelID, expressId, false);
		const colourRef = line?.SurfaceColour?.value;
		if (!colourRef) {
			continue;
		}
		const rgb = colourById.get(colourRef);
		if (rgb) {
			renderingColorById.set(expressId, rgb);
		}
	}

	const surfaceStyleColors = new Map();
	const surfaceStyleLines = ifcAPI.GetLineIDsWithType(modelID, WebIFC.IFCSURFACESTYLE);
	for (let i = 0; i < surfaceStyleLines.size(); i++) {
		const expressId = surfaceStyleLines.get(i);
		const line = ifcAPI.GetLine(modelID, expressId, false);
		const styles = line?.Styles;
		const styleList = Array.isArray(styles) ? styles : (styles ? [styles] : []);
		for (const styleRef of styleList) {
			const rgb = renderingColorById.get(styleRef?.value);
			if (rgb) {
				surfaceStyleColors.set(expressId, rgb);
				break;
			}
		}
	}

	const presentationStyleColors = new Map();
	const presentationLines = ifcAPI.GetLineIDsWithType(modelID, WebIFC.IFCPRESENTATIONSTYLEASSIGNMENT);
	for (let i = 0; i < presentationLines.size(); i++) {
		const expressId = presentationLines.get(i);
		const line = ifcAPI.GetLine(modelID, expressId, false);
		const styles = line?.Styles;
		const styleList = Array.isArray(styles) ? styles : (styles ? [styles] : []);
		for (const styleRef of styleList) {
			const rgb = surfaceStyleColors.get(styleRef?.value) || renderingColorById.get(styleRef?.value);
			if (rgb) {
				presentationStyleColors.set(expressId, rgb);
				break;
			}
		}
	}

	function resolveStyleColor(styleRef) {
		const styleId = styleRef?.value;
		if (!styleId) {
			return null;
		}
		return presentationStyleColors.get(styleId)
			|| surfaceStyleColors.get(styleId)
			|| renderingColorById.get(styleId);
	}

	const styledLines = ifcAPI.GetLineIDsWithType(modelID, WebIFC.IFCSTYLEDITEM);
	for (let i = 0; i < styledLines.size(); i++) {
		const line = ifcAPI.GetLine(modelID, styledLines.get(i), false);
		const itemRef = line?.Item?.value;
		if (!itemRef) {
			continue;
		}
		const styles = line?.Styles;
		const styleList = Array.isArray(styles) ? styles : (styles ? [styles] : []);
		for (const styleRef of styleList) {
			const rgb = resolveStyleColor(styleRef);
			if (rgb) {
				colorByExpressId.set(itemRef, rgb);
				break;
			}
		}
	}

	ctx.styledColorByExpressId = colorByExpressId;
	ctx.log('Indexed styled colors: ' + colorByExpressId.size);
}

function resolveMeshColor(ctx, placedGeometry) {
	const c = placedGeometry.color;
	let rgb = [c.x, c.y, c.z];
	const opacity = c.w;

	if (isNearWhiteColor(rgb)) {
		const styled = ctx.styledColorByExpressId?.get(placedGeometry.geometryExpressID)
			|| ctx.styledColorByExpressId?.get(placedGeometry.expressID);
		if (styled) {
			rgb = styled;
		}
	}

	return { color: rgb, opacity };
}

function createObject(ctx, flatMesh) {
	const flatMeshExpressID = flatMesh.expressID;
	const placedGeometries = flatMesh.geometries;
	const meshIds = [];

	let entityId = ctx.expressGuidById.get(flatMeshExpressID);
	let metaObjectType = ctx.expressTypeById.get(flatMeshExpressID);

	if (!entityId || !metaObjectType) {
		const properties = ctx.ifcAPI.GetLine(ctx.modelID, flatMeshExpressID, false);
		entityId = properties?.GlobalId?.value;
		metaObjectType = getIfcTypeName(properties);
		if (entityId) {
			ctx.expressGuidById.set(flatMeshExpressID, entityId);
			ctx.expressTypeById.set(flatMeshExpressID, metaObjectType);
		}
	}

	if (!entityId || !shouldIncludeGeometry(ctx, metaObjectType)) {
		return;
	}

	for (let j = 0, lenj = placedGeometries.size(); j < lenj; j++) {
		const placedGeometry = placedGeometries.get(j);
		const geometryId = '' + placedGeometry.geometryExpressID;

		if (!ctx.xktModel.geometries[geometryId]) {
			const geometry = ctx.ifcAPI.GetGeometry(ctx.modelID, placedGeometry.geometryExpressID);
			const vertexData = ctx.ifcAPI.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
			const indices = ctx.ifcAPI.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize());

			const numVerts = vertexData.length / 6;
			const positions = new Float32Array(numVerts * 3);
			for (let k = 0; k < numVerts; k++) {
				positions[k * 3 + 0] = vertexData[k * 6 + 0];
				positions[k * 3 + 1] = vertexData[k * 6 + 1];
				positions[k * 3 + 2] = vertexData[k * 6 + 2];
			}

			ctx.xktModel.createGeometry({
				geometryId,
				primitiveType: 'triangles',
				positions,
				normals: null,
				indices,
			});

			ctx.stats.numGeometries++;
			ctx.stats.numVertices += numVerts;
			ctx.stats.numTriangles += indices.length / 3;
		}

		const meshId = 'mesh' + ctx.nextId++;
		const meshColor = resolveMeshColor(ctx, placedGeometry);
		ctx.xktModel.createMesh({
			meshId,
			geometryId,
			matrix: placedGeometry.flatTransformation,
			color: meshColor.color,
			opacity: meshColor.opacity,
		});
		meshIds.push(meshId);
	}

	if (meshIds.length > 0) {
		ctx.xktModel.createEntity({ entityId, meshIds });
		ctx.stats.numObjects++;
	}
}

function detectIfcSchema(data) {
	const head = new TextDecoder('utf-8', { fatal: false }).decode(
		data instanceof Uint8Array ? data.slice(0, 65536) : new Uint8Array(data).slice(0, 65536),
	);
	const match = head.match(/FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i);
	return match ? match[1] : '';
}

function parseIFCFast({
	WebIFC,
	data,
	xktModel,
	autoNormals = true,
	includeTypes,
	excludeTypes = DEFAULT_EXCLUDE_META_TYPES,
	excludeGeometryTypes = DEFAULT_EXCLUDE_GEOMETRY_TYPES,
	externalMetadata = false,
	wasmPath,
	stats = {},
	log,
}) {
	if (log) {
		log('Using parser: parseIFCFast');
		if (externalMetadata) {
			log('External metadata mode: property sets stored outside XKT');
		}
		if (excludeGeometryTypes?.length) {
			log('Excluding geometry for types: ' + excludeGeometryTypes.join(', '));
		}
	}

	return new Promise((resolve, reject) => {
		if (!data) {
			reject('Argument expected: data');
			return;
		}
		if (!xktModel) {
			reject('Argument expected: xktModel');
			return;
		}
		if (!wasmPath) {
			reject('Argument expected: wasmPath');
			return;
		}

		const ifcAPI = new WebIFC.IfcAPI();
		const normalizedWasmPath = wasmPath.endsWith('/') ? wasmPath : wasmPath + '/';
		ifcAPI.SetWasmPath(normalizedWasmPath, true);

		ifcAPI.Init().then(() => {
			const dataArray = new Uint8Array(data);
			const timings = {};
			const schemaVersion = detectIfcSchema(dataArray);

			stats.sourceFormat = 'IFC';
			stats.schemaVersion = schemaVersion;
			if (schemaVersion) {
				log('IFC schema: ' + schemaVersion);
			}
			stats.title = '';
			stats.author = '';
			stats.created = '';
			stats.numMetaObjects = 0;
			stats.numPropertySets = 0;
			stats.numObjects = 0;
			stats.numGeometries = 0;
			stats.numTriangles = 0;
			stats.numVertices = 0;
			const modelID = ifcAPI.OpenModel(dataArray, IFC_LOADER_SETTINGS);

			const ctx = {
				WebIFC,
				modelID,
				ifcAPI,
				xktModel,
				autoNormals,
				externalMetadata,
				log: log || (() => {}),
				nextId: 0,
				stats,
				expressGuidById: new Map(),
				expressTypeById: new Map(),
				expressTypeByGuid: new Map(),
			};

			if (externalMetadata) {
				ctx.externalMetadata = {
					version: 1,
					propertySets: {},
					objectPropertySets: {},
					objectPropertySetSources: {},
				};
				stats.externalMetadata = ctx.externalMetadata;
			}

			if (includeTypes) {
				ctx.includeTypes = {};
				for (const type of includeTypes) {
					ctx.includeTypes[type] = true;
				}
			}

			if (excludeTypes) {
				ctx.excludeTypes = {};
				for (const type of excludeTypes) {
					ctx.excludeTypes[type] = true;
				}
			}

			if (excludeGeometryTypes) {
				ctx.excludeGeometryTypes = {};
				for (const type of excludeGeometryTypes) {
					ctx.excludeGeometryTypes[type] = true;
				}
			}

			const projectLines = ifcAPI.GetLineIDsWithType(modelID, WebIFC.IFCPROJECT);
			const ifcProjectId = projectLines.get(0);

			xktModel.schema = '';
			xktModel.modelId = '' + modelID;
			xktModel.projectId = '' + ifcProjectId;

			let 			phaseStart = Date.now();
			log('Indexing Revit IFC surface colors...');
			buildStyledColorIndex(ctx);
			timings.surfaceColorsMs = Date.now() - phaseStart;

			phaseStart = Date.now();
			log('Parsing geometry (streamed)...');
			try {
				parseGeometry(ctx);
			} catch (geometryError) {
				reject(geometryError?.message || geometryError);
				return;
			}
			timings.geometryMs = Date.now() - phaseStart;
			log('Geometry phase: ' + (timings.geometryMs / 1000).toFixed(1) + ' s');

			phaseStart = Date.now();
			log('Parsing metadata tree...');
			parseMetadata(ctx);
			timings.metadataMs = Date.now() - phaseStart;
			log('Metadata phase: ' + (timings.metadataMs / 1000).toFixed(1) + ' s');

			phaseStart = Date.now();
			log('Parsing property sets...');
			parsePropertySetsFast(ctx);
			timings.propertiesMs = Date.now() - phaseStart;
			log('Property sets phase: ' + (timings.propertiesMs / 1000).toFixed(1) + ' s');

			ifcAPI.CloseModel(modelID);
			stats.timings = timings;
			resolve();
		}).catch(reject);
	});
}

export {
	parseIFCFast,
	DEFAULT_EXCLUDE_GEOMETRY_TYPES,
	DEFAULT_EXCLUDE_META_TYPES,
};
