/**
 * Adapter for xeokit-bim-viewer private APIs.
 * Centralizes access so viewer-init.mjs does not depend on underscore fields directly.
 */

export function getBusyModal(bimViewer) {
	return bimViewer?._busyModal ?? null;
}

export function getBusyModalElement(busyModal) {
	return busyModal?._modal ?? null;
}

export function getSectionTool(bimViewer) {
	return bimViewer?._sectionTool ?? null;
}

export function getSelectionTool(bimViewer) {
	return bimViewer?._selectionTool ?? null;
}

export function getPropertiesInspector(bimViewer) {
	return bimViewer?._propertiesInspector ?? null;
}

export function isPropertiesInspectorEnabled(bimViewer) {
	return bimViewer?._enablePropertiesInspector === true;
}

export function setExternalMetadataFlag(bimViewer, server, enabled) {
	if (enabled !== true) {
		return;
	}
	server._externalMetadata = true;
	bimViewer._externalMetadata = true;
}

export function usesExternalMetadata(bimViewer, server) {
	return bimViewer?._externalMetadata === true || server?._externalMetadata === true;
}

export function getStoreysTreeView(bimViewer) {
	return bimViewer?._storeysExplorer?._treeView ?? null;
}

export function getExplorerTreeViews(bimViewer) {
	return [
		bimViewer?._objectsExplorer?._treeView,
		bimViewer?._classesExplorer?._treeView,
		bimViewer?._storeysExplorer?._treeView,
	].filter(Boolean);
}

export function getContextMenus(bimViewer) {
	return [
		bimViewer?._objectContextMenu,
		bimViewer?._canvasContextMenu,
		bimViewer?._storeysExplorer?._treeViewContextMenu,
		bimViewer?._objectsExplorer?._treeViewContextMenu,
		bimViewer?._classesExplorer?._treeViewContextMenu,
	].filter(Boolean);
}

export function getContextMenuItems(menu) {
	return menu?._itemList ?? [];
}

export function setTreeAutoExpandDepth(treeView, depth) {
	treeView._autoExpandDepth = depth;
}

export function collapseTreeView(treeView) {
	treeView.collapse();
}

export function wrapTreeCreateNodes(treeView, wrapper) {
	const originalCreateNodes = treeView._createNodes.bind(treeView);
	treeView._createNodes = wrapper(originalCreateNodes);
}

export function rebuildTreeView(treeView) {
	treeView._createNodes();
}

export function clearTreeRootName(treeView, modelId) {
	delete treeView._rootNames[modelId];
}

export function forEachTreeRootNode(treeView, callback) {
	for (const rootNode of treeView._rootNodes) {
		callback(rootNode);
	}
}

export function walkTreeNode(treeView, rootNode, callback) {
	treeView._withNodeTree(rootNode, callback);
}

export function syncTreeNodesToEntities(treeView) {
	treeView._synchNodesToEntities();
}

export function setTreeNodeCheckbox(treeView, nodeId, checked, animate = false) {
	treeView._renderService.setCheckbox(nodeId, checked, animate);
}

export function getTreeRootObjectIds(treeView) {
	return treeView._rootNodes.map((root) => root.objectId);
}

export function withTreeEventsMuted(treeView, callback) {
	const sceneMuted = treeView._muteSceneEvents;
	const treeMuted = treeView._muteTreeEvents;
	treeView._muteSceneEvents = true;
	treeView._muteTreeEvents = true;
	try {
		return callback();
	} finally {
		treeView._muteSceneEvents = sceneMuted;
		treeView._muteTreeEvents = treeMuted;
	}
}

export function showBusyModal(bimViewer, message = '') {
	getBusyModal(bimViewer)?.show(message);
}

export function scheduleSelectionToolActivation(bimViewer) {
	getSelectionTool(bimViewer)?.scheduleInitialActivation?.();
}
