/**
 * xeokit-bim-viewer — full BIM UI (explorer, toolbar, sections, measurements).
 */
import {
	clearTreeRootName,
	collapseTreeView,
	forEachTreeRootNode,
	getBusyModal,
	getBusyModalElement,
	getContextMenuItems,
	getContextMenus,
	getExplorerTreeViews,
	getPropertiesInspector,
	getSectionTool,
	getSelectionTool,
	getStoreysTreeView,
	getTreeRootObjectIds,
	isPropertiesInspectorEnabled,
	rebuildTreeView,
	setExternalMetadataFlag,
	setTreeAutoExpandDepth,
	setTreeNodeCheckbox,
	showBusyModal,
	syncTreeNodesToEntities,
	usesExternalMetadata,
	walkTreeNode,
	withTreeEventsMuted,
	wrapTreeCreateNodes,
} from './xeokit-adapter.mjs';

const BIM_VIEWER_VERSION = '2.7.1';
const BIM_VIEWER_BASE = 'https://cdn.jsdelivr.net/npm/@xeokit/xeokit-bim-viewer@' + BIM_VIEWER_VERSION + '/dist/';

const root = document.getElementById('ifcviewer-app');
if (!root) {
	throw new Error('[ifcviewer] Root element not found');
}

const apiBase = resolveApiBase(root);
const fileName = root.dataset.fileName || 'IFC model';
const statusEl = document.getElementById('ifcviewer-status');
const isPublic = root.dataset.isPublic === '1';
const initialExternalMetadata = root.dataset.externalMetadata === '1';
const PROJECT_ID = 'ifc';
const MODEL_ID = 'model';

const sleep = (ms) => new Promise((resolve) => {
	window.setTimeout(resolve, ms);
});

function resolveApiBase(rootEl) {
	const configured = String(rootEl?.dataset?.bimApi || '').trim().replace(/\/$/, '');
	if (configured.includes('/api/bim/')) {
		return configured;
	}

	const fileId = String(rootEl?.dataset?.fileId || '').trim();
	const shareToken = String(rootEl?.dataset?.shareToken || '').trim();
	const origin = window.location.origin;
	const appRoot = '/index.php/apps/ifcviewer/api/bim';

	if (shareToken) {
		return `${origin}${appRoot}/s/${encodeURIComponent(shareToken)}`;
	}
	if (fileId) {
		return `${origin}${appRoot}/${encodeURIComponent(fileId)}`;
	}
	if (configured) {
		return configured;
	}

	console.error('[ifcviewer] BIM API base URL is missing');
	return '';
}

function formatViewerError(message, code) {
	const text = String(message || 'IFC conversion failed');
	if (isPublic) {
		if (code === 'file_too_large') {
			return text;
		}
		const publicSafe = [
			'Файл слишком большой',
			'Конвертация IFC прервана',
			'Файл не является корректным IFC',
			'В IFC нет отображаемой геометрии',
			'IFC conversion produced no visible geometry',
			'Ожидание свободного слота конвертации',
			'Большая модель',
		];
		if (publicSafe.some((prefix) => text.includes(prefix))) {
			return text;
		}
		return 'Не удалось подготовить модель к просмотру. Обратитесь к владельцу файла.';
	}
	if (code === 'file_too_large') {
		return text;
	}
	if (text.includes('Aborted') || text.includes('TriangulateBounds')) {
		return text + ' Рекомендуется экспорт Revit: IFC2x3 CV 2.0, LOD 0.3, UseOnlyTriangulation=true.';
	}
	if (text.includes('no visible geometry') || text.includes('No drawable objects')) {
		return text + ' Проверьте, что в Revit отключены ExportRoomsInView и Export2DElements.';
	}
	return text;
}

async function requestPrepare(prepareUrl) {
	const response = await fetch(prepareUrl, { method: 'POST', credentials: 'same-origin' });
	if (!response.ok) {
		const detail = response.status === 429
			? 'Слишком много запросов. Подождите минуту и обновите страницу.'
			: `Ошибка сервера (${response.status})`;
		throw new Error(detail);
	}
	return response.json();
}

// Start server-side IFC→XKT conversion before xeokit JS finishes loading.
if (apiBase) {
	requestPrepare(`${apiBase}/prepare`)
		.then((status) => {
			if (status.state === 'error' && status.message) {
				window.__ifcviewerEarlyError = formatViewerError(status.message, status.code);
			}
			if (status.externalMetadata) {
				window.__ifcviewerExternalMetadata = true;
			}
		})
		.catch((err) => {
			window.__ifcviewerEarlyError = String(err?.message || err);
		});
}

function setStatus(msg, visible) {
	if (!statusEl) {
		return;
	}
	statusEl.textContent = msg;
	statusEl.classList.toggle('hidden', !visible);
}

function formatElapsed(seconds) {
	const total = Math.max(0, Math.round(seconds || 0));
	const minutes = Math.floor(total / 60);
	const secs = total % 60;
	if (minutes > 0) {
		return `${minutes}m ${secs}s`;
	}
	return `${secs}s`;
}

function createLoadingTracker(defaultFileName) {
	const state = {
		fileName: defaultFileName,
		percent: 0,
		error: null,
		complete: false,
		statusMessage: null,
		elapsed: 0,
		estimated: 0,
		onChange: null,
	};

	return {
		get error() {
			return state.error;
		},
		get percent() {
			return state.percent;
		},
		get fileName() {
			return state.fileName;
		},
		get complete() {
			return state.complete;
		},
		get statusMessage() {
			return state.statusMessage;
		},
		get elapsed() {
			return state.elapsed;
		},
		setFileName(name) {
			state.fileName = name || defaultFileName;
			state.onChange?.();
		},
		setPercent(percent) {
			state.percent = Math.max(0, Math.min(100, Math.round(percent)));
			state.onChange?.();
		},
		setStatus(status) {
			if (typeof status.progress === 'number') {
				state.percent = Math.max(state.percent, Math.round(status.progress));
			}
			if (typeof status.elapsed === 'number') {
				state.elapsed = status.elapsed;
			}
			if (typeof status.estimated === 'number') {
				state.estimated = status.estimated;
			}
			state.statusMessage = status.warning || status.message || null;
			state.onChange?.();
		},
		setError(error) {
			state.error = error ? String(error) : null;
			state.onChange?.();
		},
		setComplete(complete = true) {
			state.complete = complete;
			state.onChange?.();
		},
		set onChange(fn) {
			state.onChange = fn;
		},
	};
}

function patchBusyModal(bimViewer, loadingTracker) {
	const busyModal = getBusyModal(bimViewer);
	const modal = getBusyModalElement(busyModal);
	if (!modal) {
		return;
	}

	modal.style.backgroundColor = 'rgba(0, 0, 0, 0.85)';
	modal.classList.add('ifcviewer-busy-hidden');
	modal.classList.remove('ifcviewer-busy-open');

	const setModalOpen = (open) => {
		modal.classList.toggle('ifcviewer-busy-open', open);
		modal.classList.toggle('ifcviewer-busy-hidden', !open);
	};

	const dismissModal = () => {
		busyModal._modalVisible = false;
		setModalOpen(false);
	};

	const content = modal.querySelector('.xeokit-busy-modal-content');
	if (content) {
		content.classList.add('ifcviewer-busy-modal-content');
	}

	const body = modal.querySelector('.xeokit-busy-modal-body');
	if (!body) {
		return;
	}

	body.innerHTML = [
		'<div class="ifcviewer-busy-message xeokit-busy-modal-message">',
		'  <div class="ifcviewer-busy-main">',
		'    <span class="ifcviewer-busy-filename"></span>',
		'    <span class="ifcviewer-busy-sep">|</span>',
		'    <span class="ifcviewer-busy-loading"><span class="ifcviewer-busy-label">Preparing:</span> <span class="ifcviewer-busy-percent">0%</span></span>',
		'  </div>',
		'  <div class="ifcviewer-busy-status"></div>',
		'  <div class="ifcviewer-busy-controls">WASD - перемещение; QE - вращение; ZX - вниз, вверх</div>',
		'</div>',
	].join('');

	const filenameEl = body.querySelector('.ifcviewer-busy-filename');
	const labelEl = body.querySelector('.ifcviewer-busy-label');
	const percentEl = body.querySelector('.ifcviewer-busy-percent');
	const statusEl = body.querySelector('.ifcviewer-busy-status');

	const render = () => {
		filenameEl.textContent = `"${loadingTracker.fileName || fileName}"`;
		filenameEl.title = loadingTracker.fileName || fileName;
		percentEl.textContent = `${loadingTracker.percent}%`;

		const showLongWait = loadingTracker.percent >= 90
			|| (loadingTracker.elapsed > 0 && loadingTracker.elapsed > loadingTracker.estimated);
		let statusText = '';
		let statusIsError = false;
		if (loadingTracker.error) {
			statusText = String(loadingTracker.error);
			statusIsError = true;
		} else if (showLongWait && loadingTracker.elapsed > 0) {
			labelEl.textContent = 'Converting:';
			statusText = loadingTracker.statusMessage
				|| `Large model (${formatElapsed(loadingTracker.elapsed)} elapsed)`;
		} else {
			labelEl.textContent = 'Preparing:';
		}

		statusEl.textContent = statusText;
		statusEl.classList.toggle('is-error', statusIsError);
	};

	loadingTracker.onChange = () => {
		render();
		if (loadingTracker.complete && !loadingTracker.error) {
			dismissModal();
		}
	};

	busyModal.show = function showBusyModal(message) {
		if (loadingTracker.complete && !loadingTracker.error) {
			return;
		}
		const match = String(message || '').match(/^Loading\s+(.+)$/i);
		if (match?.[1]) {
			loadingTracker.setFileName(match[1].trim());
		}
		render();
		busyModal._modalVisible = true;
		setModalOpen(true);
	};

	busyModal.hide = function hideBusyModal() {
		if (loadingTracker.error) {
			render();
			busyModal._modalVisible = true;
			setModalOpen(true);
			return;
		}
		if (!loadingTracker.complete && loadingTracker.percent < 100) {
			render();
			busyModal._modalVisible = true;
			setModalOpen(true);
			return;
		}
		dismissModal();
	};

	busyModal.dismiss = dismissModal;
}

function closeViewer() {
	if (window.history.length > 1) {
		window.history.back();
		return;
	}
	window.location.href = (typeof OC !== 'undefined' && OC.generateUrl)
		? OC.generateUrl('/apps/files/')
		: '/apps/files/';
}

function mountCloseButtonInToolbar() {
	if (isPublic) {
		return;
	}
	const toolbarInner = document.querySelector('#myToolbar .xeokit-toolbar');
	if (!toolbarInner || document.getElementById('ifc-btn-close')) {
		return;
	}
	const groups = toolbarInner.querySelectorAll('.xeokit-btn-group');
	const lastGroup = groups[groups.length - 1];
	if (!lastGroup) {
		return;
	}
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.id = 'ifc-btn-close';
	btn.className = 'ifcviewer-close xeokit-btn fas fa-times fa-2x';
	btn.title = 'Close';
	btn.addEventListener('click', closeViewer);
	lastGroup.appendChild(btn);
}

/**
 * NavCube uses pageX/Y minus offsetParent chain; that breaks in Nextcloud layout.
 * Main canvas must keep native pageX/Y — TransformControl (section gizmo drag) uses
 * pageX + transformToNode(documentElement, canvas) and breaks if pageX is rewritten.
 */
function applyNavCubeLayout(canvas) {
	const shell = document.getElementById('ifcviewer-app');
	if (!canvas || !shell) {
		return;
	}

	const styles = getComputedStyle(shell);
	const bottom = styles.getPropertyValue('--ifc-toolbar-bottom').trim() || '14px';
	const toolbarHeight = styles.getPropertyValue('--ifc-toolbar-height').trim() || '54px';
	const gap = styles.getPropertyValue('--ifc-navcube-gap').trim() || '8px';
	const size = styles.getPropertyValue('--ifc-navcube-size').trim() || '150px';

	canvas.style.setProperty('position', 'absolute', 'important');
	canvas.style.setProperty('left', '50%', 'important');
	canvas.style.setProperty('right', 'auto', 'important');
	canvas.style.setProperty('top', 'auto', 'important');
	canvas.style.setProperty(
		'bottom',
		`calc(${bottom} + ${toolbarHeight} + ${gap})`,
		'important',
	);
	canvas.style.setProperty('transform', 'translateX(-50%)', 'important');
	canvas.style.setProperty('width', size, 'important');
	canvas.style.setProperty('height', size, 'important');
	canvas.style.setProperty('opacity', '0.38', 'important');
	canvas.style.setProperty('z-index', '45', 'important');
}

function patchNavCubeLayout(canvas) {
	if (!canvas || canvas.__ifcviewerLayoutPatched) {
		return;
	}

	const apply = () => applyNavCubeLayout(canvas);
	apply();

	const viewerContainer = document.getElementById('myViewer');
	if (viewerContainer && typeof ResizeObserver !== 'undefined') {
		new ResizeObserver(() => apply()).observe(viewerContainer);
	}

	window.addEventListener('resize', apply);
	canvas.__ifcviewerLayoutPatched = true;
}

function patchNavCubePointerCoords(canvas) {
	if (!canvas) {
		return;
	}

	const fixPointerCoords = (event) => {
		const rect = canvas.getBoundingClientRect();
		let offsetLeft = 0;
		let offsetTop = 0;
		let element = event.target;
		while (element?.offsetParent) {
			offsetLeft += element.offsetLeft;
			offsetTop += element.offsetTop;
			element = element.offsetParent;
		}

		const canvasX = event.clientX - rect.left;
		const canvasY = event.clientY - rect.top;

		Object.defineProperty(event, 'pageX', { value: offsetLeft + canvasX, configurable: true });
		Object.defineProperty(event, 'pageY', { value: offsetTop + canvasY, configurable: true });
	};

	for (const type of ['mousedown', 'mouseup', 'mousemove', 'touchstart', 'touchmove', 'touchend', 'contextmenu']) {
		canvas.addEventListener(type, fixPointerCoords, true);
	}
}

/**
 * xeokit SectionTool creates a section on every container mouseup while the tool is active.
 * That also runs after gizmo drag and toolbar clicks — block those cases.
 */
function patchSectionTool(bimViewer) {
	const sectionTool = getSectionTool(bimViewer);
	const canvas = bimViewer.viewer?.canvas?.canvas || document.getElementById('myCanvas');
	if (!sectionTool || !canvas || sectionTool.__ifcviewerSectionPatched) {
		return;
	}

	const container = sectionTool._containerElement;
	if (!container) {
		return;
	}

	let pointerDownOnGizmo = false;
	let pointerDownOnUi = false;

	const isMainCanvasTarget = (target) => target === canvas || !!target?.closest?.('#myCanvas');

	const isUiTarget = (target) => !!target?.closest?.(
		'#myToolbar, .xeokit-toolbar, .xeokit-context-menu, #myExplorer, #myInspector, '
		+ '.explorer_toggle_label, .inspector_toggle_label, .ifcviewer-close',
	);

	const isGizmoPick = (pickResult) => {
		const entity = pickResult?.entity;
		return !!entity && (entity.isUI === true || entity.isObject === false);
	};

	const getCanvasPos = (event) => {
		const rect = canvas.getBoundingClientRect();
		return [event.clientX - rect.left, event.clientY - rect.top];
	};

	container.addEventListener('mousedown', (event) => {
		if (event.button !== 0) {
			return;
		}

		pointerDownOnUi = isUiTarget(event.target) || !isMainCanvasTarget(event.target);
		pointerDownOnGizmo = false;

		if (!pointerDownOnUi && sectionTool.getActive?.() && sectionTool.getEnabled?.()) {
			const pickResult = bimViewer.viewer.scene.pick({
				canvasPos: getCanvasPos(event),
				pickSurface: true,
			});
			pointerDownOnGizmo = isGizmoPick(pickResult);
		}
	}, true);

	container.addEventListener('mouseup', (event) => {
		if (event.button !== 0) {
			return;
		}
		if (!sectionTool.getActive?.() || !sectionTool.getEnabled?.()) {
			pointerDownOnUi = false;
			pointerDownOnGizmo = false;
			return;
		}

		const shouldCreateSection = isMainCanvasTarget(event.target)
			&& !isUiTarget(event.target)
			&& !pointerDownOnUi
			&& !pointerDownOnGizmo;

		pointerDownOnUi = false;
		pointerDownOnGizmo = false;

		if (!shouldCreateSection) {
			event.stopImmediatePropagation();
		}
	}, true);

	sectionTool.__ifcviewerSectionPatched = true;
}

function patchDisableAutoSelectionTool(bimViewer) {
	const selectionTool = getSelectionTool(bimViewer);
	if (!selectionTool || selectionTool.__ifcviewerNoAutoSelectPatched) {
		return;
	}

	selectionTool.scheduleInitialActivation = () => {};
	selectionTool.__ifcviewerNoAutoSelectPatched = true;
}

function escapeHtml(value) {
	if (value === null || value === undefined) {
		return '';
	}
	if (typeof value === 'object') {
		try {
			return escapeHtml(JSON.stringify(value));
		} catch {
			return escapeHtml(String(value));
		}
	}
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function capitalizeLabel(str) {
	if (!str) {
		return str;
	}
	return str.charAt(0).toUpperCase() + str.slice(1);
}

function buildMetaObjectIndex(metaScene) {
	const byOriginalId = new Map();
	for (const id of Object.keys(metaScene.metaObjects)) {
		const metaObject = metaScene.metaObjects[id];
		if (metaObject.originalSystemId) {
			byOriginalId.set(metaObject.originalSystemId, id);
		}
		byOriginalId.set(id, id);
	}
	metaScene._ifcviewerIdIndex = byOriginalId;
}

function getSanitizedPropertySets(metaObject) {
	const propertySets = metaObject.propertySets || [];
	return propertySets.filter((propertySet) => {
		return propertySet && Array.isArray(propertySet.properties) && propertySet.properties.length > 0;
	});
}

const PROPERTY_SET_SOURCE_RANK = {
	'revit-instance': 1,
	'revit-type': 2,
	'ifc-material': 3,
	'ifc-element': 4,
	'ifc-other': 5,
};

function normalizePropertySetName(name) {
	return String(name || '').trim().toLowerCase();
}

function propertySetFingerprint(propertySet) {
	const name = normalizePropertySetName(propertySet?.name);
	const props = (propertySet?.properties || [])
		.map((property) => `${property.name ?? ''}\u0000${property.value ?? ''}`)
		.sort()
		.join('\u0001');
	return `${name}\u0002${props}`;
}

function propertySetSourceRank(propertySet) {
	const source = propertySet?.source || 'ifc-other';
	return PROPERTY_SET_SOURCE_RANK[source] ?? 99;
}

function deduplicatePropertySets(propertySets) {
	const bestByFingerprint = new Map();
	const ordered = [];

	for (const propertySet of propertySets) {
		const fingerprint = propertySetFingerprint(propertySet);
		const existing = bestByFingerprint.get(fingerprint);
		if (!existing) {
			bestByFingerprint.set(fingerprint, propertySet);
			ordered.push(propertySet);
			continue;
		}
		if (propertySetSourceRank(propertySet) < propertySetSourceRank(existing)) {
			const index = ordered.indexOf(existing);
			if (index >= 0) {
				ordered[index] = propertySet;
			}
			bestByFingerprint.set(fingerprint, propertySet);
		}
	}

	return ordered;
}

function mergePropertySetsForDisplay(...groups) {
	return disambiguatePropertySetDisplayNames(deduplicatePropertySets(groups.flat()));
}

function hasPropertySetTypeSuffix(name) {
	return /\(Type\)\s*$/i.test(String(name || '').trim());
}

function getPropertySetBaseName(name) {
	return normalizePropertySetName(name).replace(/\s*\(type\)\s*$/, '');
}

function disambiguatePropertySetDisplayNames(propertySets) {
	const groups = new Map();

	propertySets.forEach((propertySet, index) => {
		const baseName = getPropertySetBaseName(propertySet.name);
		if (!groups.has(baseName)) {
			groups.set(baseName, []);
		}
		groups.get(baseName).push(index);
	});

	for (const indexes of groups.values()) {
		if (indexes.length < 2) {
			continue;
		}

		const uniqueNames = new Set(indexes.map((index) => normalizePropertySetName(propertySets[index].name)));
		if (uniqueNames.size === indexes.length) {
			continue;
		}

		for (const index of indexes) {
			const propertySet = propertySets[index];
			const source = propertySet.source || 'ifc-other';
			if (source === 'revit-type' && !hasPropertySetTypeSuffix(propertySet.name)) {
				propertySet.name = `${String(propertySet.name || '').trim()} (Type)`;
			}
		}

		const nameCounts = new Map();
		for (const index of indexes) {
			const normalized = normalizePropertySetName(propertySets[index].name);
			nameCounts.set(normalized, (nameCounts.get(normalized) || 0) + 1);
		}

		for (const index of indexes) {
			const propertySet = propertySets[index];
			const normalized = normalizePropertySetName(propertySet.name);
			const source = propertySet.source || 'ifc-other';
			if (nameCounts.get(normalized) > 1 && source === 'revit-instance') {
				propertySet.name = `${String(propertySet.name || '').trim()} (Instance)`;
			}
		}

		const seenNames = new Set();
		const sortedIndexes = [...indexes].sort(
			(left, right) => propertySetSourceRank(propertySets[left]) - propertySetSourceRank(propertySets[right]),
		);

		for (const index of sortedIndexes) {
			const propertySet = propertySets[index];
			let normalized = normalizePropertySetName(propertySet.name);
			if (seenNames.has(normalized)) {
				if (!hasPropertySetTypeSuffix(propertySet.name)) {
					propertySet.name = `${String(propertySet.name || '').trim()} (Type)`;
				}
				normalized = normalizePropertySetName(propertySet.name);
			}
			seenNames.add(normalized);
		}
	}

	return propertySets;
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

function isRevitMaterialPropertySetName(name) {
	const normalized = String(name || '').trim();
	if (normalized === 'Materials') {
		return true;
	}
	return /^Materials and Finishes(?:\s*\(Type\))?$/i.test(normalized);
}

function getPropertySetSortGroup(name, source) {
	const normalizedSource = source || 'ifc-other';
	if (isRevitMaterialPropertySetName(name)
		&& (normalizedSource === 'revit-instance' || normalizedSource === 'revit-type')) {
		return 'material';
	}
	if (normalizedSource === 'revit-instance') {
		return 'instance';
	}
	if (normalizedSource === 'revit-type') {
		return 'type';
	}
	if (normalizedSource === 'ifc-material') {
		return 'ifc-material';
	}
	if (normalizedSource === 'ifc-element' || name === 'IFC Element') {
		return 'ifc-element';
	}
	return 'ifc-other';
}

function getRevitPropertySetOrderIndex(name, group) {
	if (group === 'material') {
		if (name === 'Materials and Finishes') {
			return 0;
		}
		if (name === 'Materials') {
			return 1;
		}
		if (/\(Type\)/i.test(name)) {
			return 2;
		}
		return 3;
	}

	const baseName = String(name || '').replace(/\s*\(Type\)\s*$/i, '').trim();
	let index = REVIT_PROPERTY_SET_ORDER.indexOf(baseName);
	if (index >= 0) {
		return index;
	}
	index = REVIT_PROPERTY_SET_ORDER.indexOf(name);
	if (index >= 0) {
		return index;
	}
	return 1000 + (baseName.toLowerCase().charCodeAt(0) || 0);
}

function sortPropertySetsForDisplay(propertySets) {
	return [...propertySets].sort((left, right) => {
		const leftName = left?.name || '';
		const rightName = right?.name || '';
		const leftSource = left?.source || 'ifc-other';
		const rightSource = right?.source || 'ifc-other';
		const leftGroup = getPropertySetSortGroup(leftName, leftSource);
		const rightGroup = getPropertySetSortGroup(rightName, rightSource);
		const groupOrder = {
			material: 0,
			instance: 1,
			type: 2,
			'ifc-material': 3,
			'ifc-element': 4,
			'ifc-other': 5,
		};
		if (groupOrder[leftGroup] !== groupOrder[rightGroup]) {
			return groupOrder[leftGroup] - groupOrder[rightGroup];
		}
		const leftIndex = getRevitPropertySetOrderIndex(leftName, leftGroup);
		const rightIndex = getRevitPropertySetOrderIndex(rightName, rightGroup);
		if (leftIndex !== rightIndex) {
			return leftIndex - rightIndex;
		}
		return leftName.localeCompare(rightName, undefined, { sensitivity: 'base' });
	});
}

function resolveMetaObjectId(bimViewer, objectId) {
	if (!objectId) {
		return null;
	}

	const { viewer } = bimViewer;
	const { metaScene, scene } = viewer;

	if (metaScene.metaObjects[objectId]) {
		return objectId;
	}

	const meshMatch = objectId.match(/^(.+)\.mesh\.\d+$/);
	if (meshMatch && metaScene.metaObjects[meshMatch[1]]) {
		return meshMatch[1];
	}

	const globalId = MODEL_ID + '#' + objectId;
	if (metaScene.metaObjects[globalId]) {
		return globalId;
	}

	if (objectId.startsWith(MODEL_ID + '#')) {
		const localId = objectId.slice(MODEL_ID.length + 1);
		if (metaScene.metaObjects[localId]) {
			return localId;
		}
	}

	const entity = scene.objects[objectId];
	if (entity?.id && metaScene.metaObjects[entity.id]) {
		return entity.id;
	}

	const index = metaScene._ifcviewerIdIndex;
	if (index?.has(objectId)) {
		return index.get(objectId);
	}

	for (const id of Object.keys(metaScene.metaObjects)) {
		const metaObject = metaScene.metaObjects[id];
		if (metaObject.originalSystemId === objectId) {
			return id;
		}
	}

	return null;
}

function renderPropertiesPanel(inspector, metaObject, propertySets, localeService, isLoading = false) {
	const propertiesEl = document.querySelector('#myInspector .xeokit-properties');
	if (!propertiesEl) {
		return;
	}
	inspector._propertiesElement = propertiesEl;

	const sortedPropertySets = isLoading
		? propertySets
		: sortPropertySetsForDisplay(disambiguatePropertySetDisplayNames(deduplicatePropertySets(propertySets)));

	const html = [];
	html.push('<div class="element-attributes">');
	html.push('<table class="xeokit-table">');
	html.push(`<tr><td class="td1">Name:</td><td class="td2">${escapeHtml(metaObject.name)}</td></tr>`);
	if (metaObject.type) {
		html.push(`<tr><td class="td1">Class:</td><td class="td2">${escapeHtml(metaObject.type)}</td></tr>`);
	}
	html.push(`<tr><td class="td1">UUID:</td><td class="td2">${escapeHtml(metaObject.originalSystemId || metaObject.id)}</td></tr>`);
	html.push(`<tr><td class="td1">Viewer ID:</td><td class="td2">${escapeHtml(metaObject.id)}</td></tr>`);

	const attributes = metaObject.attributes;
	if (attributes) {
		for (const key of Object.keys(attributes)) {
			html.push(`<tr><td class="td1">${escapeHtml(capitalizeLabel(key))}:</td><td class="td2">${escapeHtml(attributes[key])}</td></tr>`);
		}
	}
	html.push('</table>');

	if (isLoading) {
		html.push('<p class="xeokit-properties-loading">Loading properties…</p>');
		html.push('</div>');
	} else if (!sortedPropertySets.length) {
		const noPropText = localeService.translate('propertiesInspector.noPropSetWarning')
			|| 'No properties sets found for this object';
		html.push(`<p class="xeokit-i18n subtitle xeokit-no-prop-set-warning" data-xeokit-i18n="propertiesInspector.noPropSetWarning">${escapeHtml(noPropText)}</p>`);
		html.push('</div>');
	} else {
		html.push('</div><div class="xeokit-accordion">');
		for (const propertySet of sortedPropertySets) {
			html.push('<div class="xeokit-accordion-container">');
			html.push(`<p class="xeokit-accordion-button"><span></span>${escapeHtml(propertySet.name || 'Property set')}</p>`);
			html.push('<div class="xeokit-accordion-panel"><table class="xeokit-table"><tbody>');
			for (const property of propertySet.properties) {
				const label = property.name || property.label || 'Property';
				html.push(`<tr><td class="td1">${escapeHtml(label)}:</td><td class="td2">${escapeHtml(property.value)}</td></tr>`);
			}
			html.push('</tbody></table></div></div>');
		}
		html.push('</div>');
	}

	propertiesEl.innerHTML = html.join('');
	inspector._metaObject = metaObject;
}

async function fetchExternalPropertySets(apiBaseUrl, objectId, propertySetIds = null) {
	if (!apiBaseUrl) {
		throw new Error('BIM API base URL is missing');
	}

	const params = new URLSearchParams();
	params.set('objectId', objectId);
	if (propertySetIds?.length) {
		params.set('propertySetIds', propertySetIds.join(','));
	}

	const url = `${apiBaseUrl}/properties?${params.toString()}`;
	const response = await fetch(url, { credentials: 'same-origin' });
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} for ${url}`);
	}
	const payload = await response.json();
	const propertySets = Array.isArray(payload?.propertySets)
		? payload.propertySets
		: Array.isArray(payload?.ocs?.data?.propertySets)
			? payload.ocs.data.propertySets
			: [];
	return propertySets;
}

function collectMetaObjectPropertySetIds(metaObject) {
	const ids = [];
	const add = (value) => {
		if (!value || ids.includes(value)) {
			return;
		}
		ids.push(value);
	};

	for (const propertySetId of metaObject?.propertySetIds || []) {
		add(propertySetId);
	}
	for (const propertySet of metaObject?.propertySets || []) {
		add(propertySet?.id);
		add(propertySet?.propertySetId);
	}

	return ids;
}

async function fetchExternalPropertySetsByIds(apiBaseUrl, propertySetIds) {
	const uniqueIds = collectMetaObjectPropertySetIds({ propertySetIds });
	if (!uniqueIds.length) {
		return [];
	}
	return fetchExternalPropertySets(apiBaseUrl, '_', uniqueIds);
}

function collectPropertyLookupIds(metaObject, resolvedId) {
	const candidates = [];
	const add = (value) => {
		if (!value || candidates.includes(value)) {
			return;
		}
		candidates.push(value);
	};

	add(metaObject?.originalSystemId);
	add(resolvedId);
	add(metaObject?.id);

	return candidates;
}

async function fetchExternalPropertySetsWithFallback(apiBaseUrl, metaObject, resolvedId) {
	const candidates = collectPropertyLookupIds(metaObject, resolvedId);
	let lastError = null;

	for (const objectId of candidates) {
		try {
			const propertySets = await fetchExternalPropertySets(apiBaseUrl, objectId);
			if (propertySets.length) {
				return propertySets;
			}
		} catch (err) {
			lastError = err;
		}
	}

	if (lastError) {
		throw lastError;
	}
	return [];
}

async function resolveObjectPropertySets(apiBaseUrl, metaObject, resolvedId, inlinePropertySets, preferExternal) {
	const taggedInline = inlinePropertySets.map((propertySet) => ({
		...propertySet,
		source: propertySet.source || 'ifc-other',
	}));

	if (!preferExternal && taggedInline.length > 0) {
		return mergePropertySetsForDisplay(taggedInline);
	}

	let externalPropertySets = [];
	try {
		externalPropertySets = await fetchExternalPropertySetsWithFallback(apiBaseUrl, metaObject, resolvedId);
		if (externalPropertySets.length === 0) {
			const propertySetIds = collectMetaObjectPropertySetIds(metaObject);
			if (propertySetIds.length > 0) {
				externalPropertySets = await fetchExternalPropertySetsByIds(apiBaseUrl, propertySetIds);
			}
		}
	} catch (err) {
		console.warn('[ifcviewer] Failed to load external properties:', err);
		if (taggedInline.length > 0) {
			return mergePropertySetsForDisplay(taggedInline);
		}
		throw err;
	}

	if (externalPropertySets.length > 0 || taggedInline.length > 0) {
		return mergePropertySetsForDisplay(externalPropertySets, taggedInline);
	}

	return [];
}

function syncExternalMetadataFlag(bimViewer, server, value) {
	setExternalMetadataFlag(bimViewer, server, value);
}

function patchPropertiesInspector(bimViewer, server, apiBaseUrl) {
	const inspector = getPropertiesInspector(bimViewer);
	if (!inspector) {
		console.warn('[ifcviewer] Properties inspector is not available');
		return;
	}
	if (!apiBaseUrl) {
		console.error('[ifcviewer] Cannot load external properties without API base URL');
	}

	let propertyRequestId = 0;

	inspector.showObjectPropertySets = function showObjectPropertySetsPatched(objectId) {
		const resolvedId = resolveMetaObjectId(bimViewer, objectId);
		const metaObject = resolvedId
			? bimViewer.viewer.metaScene.metaObjects[resolvedId]
			: null;

		if (!metaObject) {
			console.warn('[ifcviewer] No metadata for object:', objectId);
			return;
		}

		const requestId = ++propertyRequestId;
		const inlinePropertySets = getSanitizedPropertySets(metaObject);
		const preferExternal = usesExternalMetadata(bimViewer, server)
			|| window.__ifcviewerExternalMetadata === true
			|| initialExternalMetadata;

		if (!preferExternal && inlinePropertySets.length > 0) {
			renderPropertiesPanel(
				inspector,
				metaObject,
				inlinePropertySets,
				bimViewer.localeService,
			);
			return;
		}

		renderPropertiesPanel(
			inspector,
			metaObject,
			[],
			bimViewer.localeService,
			true,
		);

		resolveObjectPropertySets(apiBaseUrl, metaObject, resolvedId, inlinePropertySets, preferExternal)
			.then((propertySets) => {
				if (requestId !== propertyRequestId) {
					return;
				}
				renderPropertiesPanel(
					inspector,
					metaObject,
					propertySets,
					bimViewer.localeService,
				);
			})
			.catch((err) => {
				if (requestId !== propertyRequestId) {
					return;
				}
				console.warn('[ifcviewer] Failed to load properties:', err);
				renderPropertiesPanel(
					inspector,
					metaObject,
					inlinePropertySets,
					bimViewer.localeService,
				);
			});
	};

	bimViewer.showObjectProperties = function showObjectPropertiesPatched(objectId) {
		const resolvedId = resolveMetaObjectId(bimViewer, objectId);
		if (!resolvedId) {
			console.warn('[ifcviewer] Inspect Properties: no metadata for', objectId);
			return;
		}
		if (isPropertiesInspectorEnabled(bimViewer)) {
			getPropertiesInspector(bimViewer).showObjectPropertySets(resolvedId);
		}
		bimViewer.fire('openInspector', {});
	};
}

function patchEdgeRendering(bimViewer) {
	const renderer = bimViewer.viewer?.scene?._renderer;
	if (!renderer || renderer.__ifcviewerEdgesPatched) {
		return;
	}
	const original = renderer.setEdgesEnabled.bind(renderer);
	renderer.setEdgesEnabled = () => original(false);
	renderer.__ifcviewerEdgesPatched = true;
	original(false);
}

function patchSmoothMouseWheel(bimViewer) {
	const viewer = bimViewer.viewer;
	const cameraControl = viewer?.cameraControl;
	const canvas = viewer?.canvas?.canvas || document.getElementById('myCanvas');
	if (!canvas || !cameraControl || canvas.__ifcviewerWheelPatched) {
		return;
	}

	cameraControl.zoomOnMouseWheel = false;
	cameraControl.dollyInertia = 0;

	// Fixed world-space dolly per wheel line — same speed inside and outside the model.
	const MOUSE_WHEEL_DOLLY_PER_LINE = 0.12;

	canvas.addEventListener('wheel', (event) => {
		if (!cameraControl.active || !cameraControl.pointerEnabled) {
			return;
		}
		event.preventDefault();
		event.stopImmediatePropagation();

		const lines = event.deltaMode === 1
			? event.deltaY
			: event.deltaY / 16;
		const clampedLines = Math.max(-5, Math.min(5, lines));
		const step = clampedLines * MOUSE_WHEEL_DOLLY_PER_LINE;

		cameraControl._updates.dollyDelta += step;
	}, { passive: false, capture: true });

	canvas.__ifcviewerWheelPatched = true;
}

const ORBIT_KEYBOARD_DOLLY_RATE = 20;
const ORBIT_KEYBOARD_PAN_RATE = 5;
const ORBIT_KEYBOARD_ROTATION_RATE = 120;
const FIRST_PERSON_KEYBOARD_DOLLY_RATE = 10;
const FIRST_PERSON_KEYBOARD_PAN_RATE = 5;
const FIRST_PERSON_SHIFT_MULTIPLIER = 3;
const VERTICAL_PAN_RATE_MULTIPLIER = 2;

const KEYBOARD_NAV_KEY_CODES = new Set([
	'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyZ', 'KeyX',
	'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
	'NumpadAdd', 'NumpadSubtract', 'Equal', 'Minus',
]);

function applyCameraMotionSettings(cameraControl) {
	cameraControl.followPointer = true;
	cameraControl.rotationInertia = 0;
	cameraControl.panInertia = 0;
	cameraControl.dragRotationRate = 300;
}

function applyNavigationRates(bimViewer, shiftHeld = false) {
	const cameraControl = bimViewer.viewer?.cameraControl;
	if (!cameraControl) {
		return;
	}

	const isFirstPerson = cameraControl.navMode === 'firstPerson';
	cameraControl.constrainVertical = isFirstPerson;

	if (isFirstPerson) {
		const mult = shiftHeld ? FIRST_PERSON_SHIFT_MULTIPLIER : 1;
		cameraControl.keyboardDollyRate = FIRST_PERSON_KEYBOARD_DOLLY_RATE * mult;
		cameraControl.keyboardPanRate = FIRST_PERSON_KEYBOARD_PAN_RATE * mult;
	} else {
		cameraControl.keyboardDollyRate = ORBIT_KEYBOARD_DOLLY_RATE;
		cameraControl.keyboardPanRate = ORBIT_KEYBOARD_PAN_RATE;
	}
	cameraControl.keyboardRotationRate = ORBIT_KEYBOARD_ROTATION_RATE;
}

function patchKeyboardShiftBoost(bimViewer, shell) {
	if (!shell || shell.__ifcviewerShiftPatched) {
		return;
	}

	let shiftHeld = false;
	const syncRates = () => applyNavigationRates(bimViewer, shiftHeld);

	shell.addEventListener('keydown', (event) => {
		if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
			shiftHeld = true;
			syncRates();
		}
	}, true);
	shell.addEventListener('keyup', (event) => {
		if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
			shiftHeld = false;
			syncRates();
		}
	}, true);
	shell.addEventListener('blur', () => {
		if (!shiftHeld) {
			return;
		}
		shiftHeld = false;
		syncRates();
	}, true);

	shell.__ifcviewerShiftPatched = true;
}

function patchWorldVerticalKeyboardPan(bimViewer) {
	const viewer = bimViewer.viewer;
	const cameraControl = viewer?.cameraControl;
	const input = viewer?.scene?.input;
	if (!viewer || !cameraControl || !input || viewer.__ifcviewerWorldVerticalPan) {
		return;
	}

	viewer.scene.on('tick', (tickEvent) => {
		if (!cameraControl.active) {
			return;
		}

		const keyDown = input.keyDown;
		const moveUp = !!keyDown[input.KEY_X];
		const moveDown = !!keyDown[input.KEY_Z];
		if (!moveUp && !moveDown) {
			return;
		}

		const elapsedSecs = tickEvent.deltaTime / 1000;
		const delta = elapsedSecs * cameraControl.keyboardPanRate * VERTICAL_PAN_RATE_MULTIPLIER;
		if (delta <= 0) {
			return;
		}

		const move = (moveUp ? delta : 0) - (moveDown ? delta : 0);
		const camera = viewer.camera;
		const worldUp = camera.worldUp;
		const eye = camera.eye;
		const look = camera.look;

		camera.eye = [
			eye[0] + worldUp[0] * move,
			eye[1] + worldUp[1] * move,
			eye[2] + worldUp[2] * move,
		];
		camera.look = [
			look[0] + worldUp[0] * move,
			look[1] + worldUp[1] * move,
			look[2] + worldUp[2] * move,
		];
	});

	viewer.__ifcviewerWorldVerticalPan = true;
}

function mountKeyboardFocus(shell) {
	if (!shell || shell.__ifcviewerKeyboardFocus) {
		return;
	}

	shell.tabIndex = 0;
	shell.addEventListener('pointerdown', () => {
		if (document.activeElement !== shell) {
			shell.focus({ preventScroll: true });
		}
	});
	shell.addEventListener('keydown', (event) => {
		if (KEYBOARD_NAV_KEY_CODES.has(event.code)) {
			event.preventDefault();
		}
	}, true);

	shell.__ifcviewerKeyboardFocus = true;
}

function applyCustomKeyMap(cameraControl, input) {
	cameraControl.keyMap = 'qwerty';
	const keyMap = { ...cameraControl.keyMap };
	// Z/X: world-vertical pan is handled in patchWorldVerticalKeyboardPan().
	keyMap[cameraControl.PAN_UP] = [];
	keyMap[cameraControl.PAN_DOWN] = [];

	const isFirstPerson = cameraControl.navMode === 'firstPerson';
	if (isFirstPerson) {
		keyMap[cameraControl.ROTATE_Y_POS] = [input.KEY_Q, input.KEY_LEFT_ARROW];
		keyMap[cameraControl.ROTATE_Y_NEG] = [input.KEY_E, input.KEY_RIGHT_ARROW];
	} else {
		keyMap[cameraControl.ROTATE_Y_POS] = [input.KEY_E, input.KEY_LEFT_ARROW];
		keyMap[cameraControl.ROTATE_Y_NEG] = [input.KEY_Q, input.KEY_RIGHT_ARROW];
	}

	cameraControl.keyMap = keyMap;
}

function patchNavModeKeyMap(bimViewer) {
	const cameraControl = bimViewer.viewer?.cameraControl;
	const input = bimViewer.viewer?.scene?.input;
	if (!cameraControl || !input || cameraControl.__ifcviewerNavModePatched) {
		return;
	}

	const proto = Object.getPrototypeOf(cameraControl);
	const desc = Object.getOwnPropertyDescriptor(proto, 'navMode');
	if (!desc?.set || !desc?.get) {
		return;
	}

	const originalSet = desc.set;
	const originalGet = desc.get;

	Object.defineProperty(cameraControl, 'navMode', {
		get() {
			return originalGet.call(this);
		},
		set(value) {
			originalSet.call(this, value);
			applyCustomKeyMap(cameraControl, input);
			applyNavigationRates(bimViewer, false);
		},
		configurable: true,
	});

	cameraControl.__ifcviewerNavModePatched = true;
}

function hideCameraPivotMarker(bimViewer) {
	const cameraControl = bimViewer.viewer?.cameraControl;
	if (!cameraControl || cameraControl.__ifcviewerPivotHidden) {
		return;
	}

	cameraControl.pivotElement = null;

	const pivotController = cameraControl._controllers?.pivotController;
	if (pivotController) {
		pivotController.hidePivot();
		pivotController.setPivotElement(null);
		if (!pivotController.__ifcviewerPivotPatched) {
			pivotController.showPivot = () => {};
			pivotController.__ifcviewerPivotPatched = true;
		}
	}

	document.querySelectorAll('.xeokit-camera-pivot-marker').forEach((el) => el.remove());
	cameraControl.__ifcviewerPivotHidden = true;
}

function applyKeyboardNavigation(bimViewer) {
	const viewer = bimViewer.viewer;
	const cameraControl = viewer?.cameraControl;
	const input = viewer?.scene?.input;
	if (!cameraControl || !input) {
		return;
	}

	hideCameraPivotMarker(bimViewer);
	patchNavModeKeyMap(bimViewer);
	cameraControl.navMode = 'orbit';
	applyCustomKeyMap(cameraControl, input);
	applyCameraMotionSettings(cameraControl);
	applyNavigationRates(bimViewer, false);
	patchKeyboardShiftBoost(bimViewer, document.getElementById('ifcviewer-app'));
	patchWorldVerticalKeyboardPan(bimViewer);
	cameraControl.keyboardEnabledOnlyIfMouseover = false;

	bimViewer.setKeyboardEnabled(true);
	input.setKeyboardEnabled(true);
}

function collectIfcBuildings(metaScene) {
	const buildings = [];
	for (const id of Object.keys(metaScene.metaObjects)) {
		const metaObject = metaScene.metaObjects[id];
		if (metaObject.type === 'IfcBuilding') {
			buildings.push(metaObject);
		}
	}
	return buildings;
}

function patchExplorerTreeHeader() {
	const tabBtn = document.querySelector('#myExplorer .xeokit-storeysTab .xeokit-tab-btn');
	if (!tabBtn) {
		return;
	}
	tabBtn.textContent = 'Explorer';
	tabBtn.classList.remove('disabled');
}

function patchStoreysExplorerCollapsed(bimViewer) {
	const treeView = getStoreysTreeView(bimViewer);
	if (!treeView) {
		return;
	}

	setTreeAutoExpandDepth(treeView, 0);

	wrapTreeCreateNodes(treeView, (originalCreateNodes) => function patchedCreateNodes() {
		originalCreateNodes();
		setTreeAutoExpandDepth(treeView, 0);
		collapseTreeView(treeView);
	});

	// resetView() fires "reset", which xeokit handles with expandToDepth(1) — undo that.
	bimViewer.on('reset', () => {
		setTreeAutoExpandDepth(treeView, 0);
		collapseTreeView(treeView);
	});
}

function collapseStoreysExplorer(bimViewer) {
	const treeView = getStoreysTreeView(bimViewer);
	if (!treeView) {
		return;
	}
	setTreeAutoExpandDepth(treeView, 0);
	collapseTreeView(treeView);
}

function applyStoreysCheckboxes(bimViewer, forceChecked = null) {
	const treeView = getStoreysTreeView(bimViewer);
	if (!treeView) {
		return;
	}

	forEachTreeRootNode(treeView, (rootNode) => {
		walkTreeNode(treeView, rootNode, (node) => {
			node.numEntities = 0;
			node.numVisibleEntities = 0;
			node.checked = false;
		});
	});

	syncTreeNodesToEntities(treeView);

	forEachTreeRootNode(treeView, (rootNode) => {
		walkTreeNode(treeView, rootNode, (node) => {
			let checked;
			if (forceChecked !== null) {
				checked = forceChecked;
				node.numVisibleEntities = forceChecked ? node.numEntities : 0;
			} else {
				checked = node.numEntities > 0 && node.numVisibleEntities > 0;
			}
			node.checked = checked;
			setTreeNodeCheckbox(treeView, node.nodeId, checked, false);
		});
	});
}

function syncStoreysTreeCheckboxes(bimViewer, forceChecked = null) {
	withStoreysTreeMuted(bimViewer, () => {
		applyStoreysCheckboxes(bimViewer, forceChecked);
	});
}

function withStoreysTreeMuted(bimViewer, callback) {
	const treeView = getStoreysTreeView(bimViewer);
	if (!treeView) {
		callback();
		return;
	}

	withTreeEventsMuted(treeView, callback);
}

function collectSceneObjectIdsUnderMetaObject(metaScene, scene, metaObjectId, ids) {
	const metaObject = metaScene.metaObjects[metaObjectId];
	if (!metaObject) {
		return ids;
	}
	if (scene.objects[metaObjectId]) {
		ids.push(metaObjectId);
	}
	for (const child of metaObject.children || []) {
		collectSceneObjectIdsUnderMetaObject(metaScene, scene, child.id, ids);
	}
	return ids;
}

function getStoreysRootMetaObjectIds(bimViewer) {
	const treeView = getStoreysTreeView(bimViewer);
	if (!treeView) {
		return [];
	}
	return getTreeRootObjectIds(treeView);
}

function collectObjectIdsForStoreysRoots(bimViewer, rootMetaObjectIds) {
	const scene = bimViewer.viewer.scene;
	const metaScene = bimViewer.viewer.metaScene;
	const ids = [];
	for (const objectId of rootMetaObjectIds) {
		collectSceneObjectIdsUnderMetaObject(metaScene, scene, objectId, ids);
	}
	return ids;
}

function getStoreysScopeObjectIds(bimViewer) {
	return collectObjectIdsForStoreysRoots(bimViewer, getStoreysRootMetaObjectIds(bimViewer));
}

function showAllStoreys(bimViewer) {
	withStoreysTreeMuted(bimViewer, () => {
		const scene = bimViewer.viewer.scene;
		const objectIds = getStoreysScopeObjectIds(bimViewer);
		if (objectIds.length === 0) {
			return;
		}

		scene.setObjectsVisible(objectIds, true);
		const xrayedInScope = scene.xrayedObjectIds.filter((id) => objectIds.includes(id));
		if (xrayedInScope.length > 0) {
			scene.setObjectsPickable(xrayedInScope, true);
			scene.setObjectsXRayed(xrayedInScope, false);
		}
		applyStoreysCheckboxes(bimViewer, true);
	});
}

function hideAllStoreys(bimViewer) {
	withStoreysTreeMuted(bimViewer, () => {
		const scene = bimViewer.viewer.scene;
		const objectIds = getStoreysScopeObjectIds(bimViewer);
		if (objectIds.length === 0) {
			return;
		}

		scene.setObjectsVisible(objectIds, false);
		applyStoreysCheckboxes(bimViewer, false);
	});
}

function resolveEntityMetaObjectId(bimViewer, entity) {
	if (!entity?.id) {
		return null;
	}
	return resolveMetaObjectId(bimViewer, entity.id);
}

function getSceneObjectIdsForMetaObject(bimViewer, metaObjectId) {
	const viewer = bimViewer.viewer;
	const { metaScene, scene } = viewer;
	const resolvedId = resolveMetaObjectId(bimViewer, metaObjectId) || metaObjectId;
	const ids = [];
	collectSceneObjectIdsUnderMetaObject(metaScene, scene, resolvedId, ids);

	const meshPrefix = `${resolvedId}.mesh.`;
	for (const objectId of Object.keys(scene.objects)) {
		if (objectId === resolvedId || objectId.startsWith(meshPrefix)) {
			ids.push(objectId);
			continue;
		}
		if (resolveMetaObjectId(bimViewer, objectId) === resolvedId) {
			ids.push(objectId);
		}
	}

	return [...new Set(ids)];
}

function setMetaObjectSubtreeVisible(bimViewer, metaObjectId, visible) {
	const scene = bimViewer.viewer.scene;
	const objectIds = getSceneObjectIdsForMetaObject(bimViewer, metaObjectId);
	if (objectIds.length === 0) {
		return false;
	}
	scene.setObjectsVisible(objectIds, visible);
	return true;
}

function setMetaObjectSubtreeXRayed(bimViewer, metaObjectId, xrayed) {
	const scene = bimViewer.viewer.scene;
	const objectIds = getSceneObjectIdsForMetaObject(bimViewer, metaObjectId);
	if (objectIds.length === 0) {
		return false;
	}

	scene.setObjectsXRayed(objectIds, xrayed);
	const xrayPickable = bimViewer.getConfig('xrayPickable');
	if (xrayed) {
		scene.setObjectsPickable(objectIds, !!xrayPickable);
	} else {
		scene.setObjectsPickable(objectIds, true);
	}
	return true;
}

function xrayAllExceptMetaObject(bimViewer, metaObjectId) {
	const scene = bimViewer.viewer.scene;
	const xrayPickable = bimViewer.getConfig('xrayPickable');

	scene.setObjectsVisible(scene.objectIds, true);
	scene.setObjectsXRayed(scene.objectIds, true);
	if (!xrayPickable) {
		scene.setObjectsPickable(scene.objectIds, false);
	}

	const keepIds = getSceneObjectIdsForMetaObject(bimViewer, metaObjectId);
	if (keepIds.length > 0) {
		scene.setObjectsXRayed(keepIds, false);
		scene.setObjectsPickable(keepIds, true);
	}
}

function applyXRayMaterialSettings(bimViewer) {
	const xrayMaterial = bimViewer.viewer?.scene?.xrayMaterial;
	if (!xrayMaterial) {
		return;
	}

	// xeokit-bim-viewer defaults: fill off + black edges on black background = invisible xray.
	xrayMaterial.fill = true;
	xrayMaterial.fillColor = [0.55, 0.58, 0.62];
	xrayMaterial.fillAlpha = 0.22;
	xrayMaterial.edges = true;
	xrayMaterial.edgeColor = [0.75, 0.8, 0.9];
	xrayMaterial.edgeAlpha = 0.45;
}

function isObjectHideContextMenuItem(entry) {
	const getTitle = entry?.getTitle;
	if (!getTitle) {
		return false;
	}
	const src = String(getTitle);
	return src.includes('objectContextMenu.hide') && !src.includes('hideOthers') && !src.includes('hideAll');
}

function isObjectHideOthersContextMenuItem(entry) {
	const getTitle = entry?.getTitle;
	if (!getTitle) {
		return false;
	}
	return String(getTitle).includes('hideOthers');
}

function isObjectShowContextMenuItem(entry) {
	const getTitle = entry?.getTitle;
	if (!getTitle) {
		return false;
	}
	const src = String(getTitle);
	return src.includes('objectContextMenu.show') && !src.includes('showAll');
}

function isShowAllContextMenuItem(entry) {
	const getTitle = entry?.getTitle;
	if (!getTitle) {
		return false;
	}
	const src = String(getTitle);
	return src.includes('showAll') || src.includes('Show All');
}

function isHideAllContextMenuItem(entry) {
	const getTitle = entry?.getTitle;
	if (!getTitle) {
		return false;
	}
	const src = String(getTitle);
	return src.includes('hideAll') || src.includes('Hide All');
}

function isObjectXRayContextMenuItem(entry) {
	const src = String(entry?.getTitle || '');
	return src.includes('objectContextMenu.xray')
		&& !src.includes('xrayOthers')
		&& !src.includes('xrayAll')
		&& !src.includes('xrayNone');
}

function isObjectXRayOthersContextMenuItem(entry) {
	return String(entry?.getTitle || '').includes('xrayOthers');
}

function isObjectXRayAllContextMenuItem(entry) {
	return String(entry?.getTitle || '').includes('xrayAll');
}

function patchContextMenuShowHideItems(bimViewer) {
	for (const menu of getContextMenus(bimViewer)) {
		// xeokit copies doAction into menu._itemList at build time — patch runtime items.
		for (const item of getContextMenuItems(menu)) {
			if (isShowAllContextMenuItem(item)) {
				item.doAction = () => showAllStoreys(bimViewer);
			} else if (isHideAllContextMenuItem(item)) {
				item.doAction = () => hideAllStoreys(bimViewer);
			} else if (isObjectHideContextMenuItem(item)) {
				item.doAction = (context) => {
					const metaObjectId = resolveEntityMetaObjectId(context.bimViewer, context.entity);
					if (!metaObjectId) {
						context.entity.visible = false;
						return;
					}
					withStoreysTreeMuted(context.bimViewer, () => {
						setMetaObjectSubtreeVisible(context.bimViewer, metaObjectId, false);
						applyStoreysCheckboxes(context.bimViewer);
					});
				};
			} else if (isObjectHideOthersContextMenuItem(item)) {
				item.doAction = (context) => {
					const viewer = context.bimViewer.viewer;
					const scene = viewer.scene;
					const metaObjectId = resolveEntityMetaObjectId(context.bimViewer, context.entity);
					if (!metaObjectId) {
						return;
					}
					withStoreysTreeMuted(context.bimViewer, () => {
						scene.setObjectsVisible(scene.visibleObjectIds, false);
						setMetaObjectSubtreeVisible(context.bimViewer, metaObjectId, true);
						applyStoreysCheckboxes(context.bimViewer);
					});
				};
			} else if (isObjectShowContextMenuItem(item)) {
				item.doAction = (context) => {
					const metaObjectId = resolveEntityMetaObjectId(context.bimViewer, context.entity);
					if (!metaObjectId) {
						context.entity.visible = true;
						return;
					}
					withStoreysTreeMuted(context.bimViewer, () => {
						setMetaObjectSubtreeVisible(context.bimViewer, metaObjectId, true);
						applyStoreysCheckboxes(context.bimViewer);
					});
				};
			} else if (isObjectXRayContextMenuItem(item)) {
				item.doAction = (context) => {
					const metaObjectId = resolveEntityMetaObjectId(context.bimViewer, context.entity);
					if (!metaObjectId) {
						context.entity.xrayed = true;
						return;
					}
					setMetaObjectSubtreeXRayed(context.bimViewer, metaObjectId, true);
				};
			} else if (isObjectXRayOthersContextMenuItem(item)) {
				item.doAction = (context) => {
					const metaObjectId = resolveEntityMetaObjectId(context.bimViewer, context.entity);
					if (!metaObjectId) {
						return;
					}
					xrayAllExceptMetaObject(context.bimViewer, metaObjectId);
				};
			} else if (isObjectXRayAllContextMenuItem(item)) {
				item.doAction = (context) => {
					const scene = context.bimViewer.viewer.scene;
					scene.setObjectsVisible(scene.objectIds, true);
					scene.setObjectsXRayed(scene.objectIds, true);
					if (!context.bimViewer.getConfig('xrayPickable')) {
						scene.setObjectsPickable(scene.objectIds, false);
					}
				};
			}
		}
	}
}

function patchStoreysShowHide(bimViewer) {
	bimViewer.setAllObjectsVisible = function setAllObjectsVisible(visible) {
		if (visible) {
			showAllStoreys(bimViewer);
			return;
		}
		hideAllStoreys(bimViewer);
	};
}

function ensureAllStoreysVisible(bimViewer) {
	showAllStoreys(bimViewer);
}

/**
 * Merged IFC models contain multiple IfcBuilding roots. xeokit TreeView uses the
 * model filename (merged.ifc) as rootName for every building — clear that override
 * so IfcBuilding.Name (set by merge_ifc.py) is shown in the left panel.
 */
function patchMergedIfcExplorerLabels(bimViewer) {
	const buildings = collectIfcBuildings(bimViewer.viewer.metaScene);
	if (buildings.length <= 1) {
		return false;
	}

	const treeViews = getExplorerTreeViews(bimViewer);
	const storeysTreeView = getStoreysTreeView(bimViewer);

	for (const treeView of treeViews) {
		clearTreeRootName(treeView, MODEL_ID);
		if (treeView === storeysTreeView) {
			setTreeAutoExpandDepth(treeView, 0);
		}
		rebuildTreeView(treeView);
	}

	collapseStoreysExplorer(bimViewer);
	syncStoreysTreeCheckboxes(bimViewer, true);
	patchExplorerTreeHeader();
	bimViewer.openTab('storeys');
	return true;
}

function applySmoothCameraControls(bimViewer) {
	patchSmoothMouseWheel(bimViewer);
	applyKeyboardNavigation(bimViewer);
}

function applyMaterialFriendlyViewerSettings(bimViewer) {
	bimViewer.setConfigs({
		edgesEnabled: false,
		saoEnabled: true,
		saoIntensity: 0.18,
		backgroundColor: [0, 0, 0],
	});
	applyXRayMaterialSettings(bimViewer);
	patchEdgeRendering(bimViewer);
	applySmoothCameraControls(bimViewer);
}

class NcBimServer {
	constructor(baseUrl, loadingTracker) {
		this.baseUrl = baseUrl.replace(/\/$/, '');
		this._loading = loadingTracker;
		this._externalMetadata = false;
	}

	getProjects(done, error) {
		this._fetchJson('/projects', done, error);
	}

	getProject(projectId, done, error) {
		this._fetchJson('/project', (project) => {
			this._externalMetadata = project?.viewerConfigs?.externalMetadata === true;
			done(project);
		}, error);
	}

	getMetadata(_projectId, _modelId, done) {
		// Must be null/undefined — empty {} is truthy and makes XKTLoader skip
		// metadata embedded in the XKT file (metaScene stays empty).
		done(null);
	}

	getGeometry(_projectId, _modelId, done, error) {
		this._ensureGeometryReady()
			.then(() => this._fetchArrayBuffer('/geometry', done, error))
			.catch((err) => error?.(err.message || String(err)));
	}

	async _fetchStatus() {
		const response = await fetch(`${this.baseUrl}/status`, { credentials: 'same-origin' });
		if (!response.ok) {
			throw new Error('HTTP ' + response.status);
		}
		const status = await response.json();
		if (status.externalMetadata) {
			this._externalMetadata = true;
		}
		return status;
	}

	async _ensureGeometryReady() {
		const loading = this._loading;
		let status = await this._fetchStatus();

		if (status.state !== 'ready') {
			try {
				status = await requestPrepare(`${this.baseUrl}/prepare`);
				if (status.externalMetadata) {
					this._externalMetadata = true;
				}
			} catch (err) {
				throw new Error(String(err?.message || err));
			}
		}

		if (status.state === 'error') {
			throw new Error(formatViewerError(status.message, status.code));
		}

		while (status.state !== 'ready') {
			if (status.state === 'error') {
				throw new Error(formatViewerError(status.message, status.code));
			}

			const progress = typeof status.progress === 'number' ? status.progress : 1;
			loading?.setStatus(status);
			loading?.setPercent(Math.max(loading?.percent || 0, progress));
			await sleep(2000);
			status = await this._fetchStatus();

			if (status.state === 'missing' || status.state === 'queued') {
				try {
					status = await requestPrepare(`${this.baseUrl}/prepare`);
					if (status.externalMetadata) {
						this._externalMetadata = true;
					}
				} catch (err) {
					throw new Error(String(err?.message || err));
				}
			}
		}

		loading?.setPercent(Math.max(loading?.percent || 0, 80));
	}

	getObjectInfo(_projectId, _modelId, objectId, done) {
		done({ id: objectId, name: objectId, type: 'IfcElement' });
	}

	getIssues(_projectId, _modelId, done) {
		done([]);
	}

	getSplitModelManifest(_projectId, _modelId, _manifestName, _done, error) {
		error?.('Split models are not supported');
	}

	getSplitModelMetadata(_projectId, _modelId, _metadataFileName, _done, error) {
		error?.('Split models are not supported');
	}

	getSplitModelGeometry(_projectId, _modelId, _geometryFileName, _done, error) {
		error?.('Split models are not supported');
	}

	_fetchJson(path, done, error) {
		fetch(this.baseUrl + path, { credentials: 'same-origin' })
			.then((response) => {
				if (!response.ok) {
					throw new Error('HTTP ' + response.status);
				}
				return response.json();
			})
			.then(done)
			.catch((err) => error?.(err.message || String(err)));
	}

	async _fetchArrayBuffer(path, done, error, retry = true) {
		const loading = this._loading;
		try {
			const response = await fetch(this.baseUrl + path, { credentials: 'same-origin' });
			if ((response.status === 503 || response.status === 404) && retry) {
				await this._ensureGeometryReady();
				return this._fetchArrayBuffer(path, done, error, false);
			}
			if (!response.ok) {
				let detail = 'HTTP ' + response.status;
				try {
					const payload = await response.json();
					if (payload?.message) {
						detail = payload.message;
					}
				} catch {
					// not JSON
				}
				throw new Error(detail);
			}

			const totalBytes = parseInt(response.headers.get('content-length') || '0', 10);
			if (!response.body || totalBytes <= 0) {
				loading?.setPercent(90);
				const buffer = await response.arrayBuffer();
				loading?.setPercent(95);
				done(buffer);
				return;
			}

			const merged = new Uint8Array(totalBytes);
			const reader = response.body.getReader();
			let offset = 0;

			while (true) {
				const { done: streamDone, value } = await reader.read();
				if (streamDone) {
					break;
				}
				merged.set(value, offset);
				offset += value.byteLength;
				loading?.setPercent(Math.min(95, Math.max(80, Math.round(80 + (offset / totalBytes) * 15))));
			}

			loading?.setPercent(95);
			const buffer = offset === merged.byteLength
				? merged.buffer
				: merged.buffer.slice(0, offset);
			done(buffer);
		} catch (err) {
			const message = err.message || String(err);
			loading?.setError(message);
			error?.(message);
		}
	}
}

async function startViewer() {
	const [{ BIMViewer, LocaleService }, { messages: localeMessages }] = await Promise.all([
		import(BIM_VIEWER_BASE + 'xeokit-bim-viewer.es.js'),
		import(BIM_VIEWER_BASE + 'messages.js'),
	]);

	localeMessages.en = localeMessages.en || {};
	localeMessages.en.storeysExplorer = {
		...(localeMessages.en.storeysExplorer || {}),
		title: 'Explorer',
	};

	const loadingTracker = createLoadingTracker(fileName);
	const server = new NcBimServer(apiBase, loadingTracker);

	const earlyStatusPoll = window.setInterval(async () => {
		try {
			const response = await fetch(`${apiBase}/status`, { credentials: 'same-origin' });
			if (!response.ok) {
				return;
			}
			const status = await response.json();
			if (status.externalMetadata) {
				window.__ifcviewerExternalMetadata = true;
			}
			if (status.state === 'converting') {
				loadingTracker.setStatus(status);
			}
			if (status.state === 'error' && status.message) {
				loadingTracker.setError(formatViewerError(status.message, status.code));
			}
			if (status.state === 'ready' || status.state === 'error') {
				window.clearInterval(earlyStatusPoll);
			}
		} catch {
			// ignore until viewer is ready
		}
	}, 2000);

	const viewerShell = document.getElementById('ifcviewer-app');
	const viewerContainer = document.getElementById('myViewer');
	mountKeyboardFocus(viewerShell);

	const navCubeCanvas = document.getElementById('myNavCubeCanvas');
	patchNavCubeLayout(navCubeCanvas);
	patchNavCubePointerCoords(navCubeCanvas);

	const bimViewer = new BIMViewer(server, {
		localeService: new LocaleService({
			messages: localeMessages,
			locale: 'en',
		}),
		enableMeasurements: true,
		canvasElement: document.getElementById('myCanvas'),
		keyboardEventsElement: viewerShell || viewerContainer || document,
		explorerElement: document.getElementById('myExplorer'),
		toolbarElement: document.getElementById('myToolbar'),
		inspectorElement: document.getElementById('myInspector'),
		navCubeCanvasElement: navCubeCanvas,
		busyModelBackdropElement: viewerContainer,
		enableEditModels: false,
	});

	mountCloseButtonInToolbar();
	patchPropertiesInspector(bimViewer, server, apiBase);
	patchBusyModal(bimViewer, loadingTracker);
	patchExplorerTreeHeader();
	patchEdgeRendering(bimViewer);
	patchStoreysExplorerCollapsed(bimViewer);
	patchStoreysShowHide(bimViewer);
	patchContextMenuShowHideItems(bimViewer);
	patchSectionTool(bimViewer);
	patchDisableAutoSelectionTool(bimViewer);
	applyMaterialFriendlyViewerSettings(bimViewer);

	syncExternalMetadataFlag(
		bimViewer,
		server,
		initialExternalMetadata || window.__ifcviewerExternalMetadata === true,
	);
	server.getProject(PROJECT_ID, (project) => {
		syncExternalMetadataFlag(
			bimViewer,
			server,
			project?.viewerConfigs?.externalMetadata === true,
		);
	}, () => {});

	bimViewer.localeService.on('updated', () => {
		patchExplorerTreeHeader();
		document.querySelectorAll('.xeokit-i18n').forEach((el) => {
			if (el.dataset.xeokitI18n) {
				el.innerText = bimViewer.localeService.translate(el.dataset.xeokitI18n);
			}
			if (el.dataset.xeokitI18ntip) {
				el.setAttribute('title', bimViewer.localeService.translate(el.dataset.xeokitI18ntip));
			}
		});
	});

	let layoutSyncScheduled = false;

	function syncViewerLayout() {
		const xeokitCanvas = bimViewer.viewer?.canvas;
		const canvasEl = xeokitCanvas?.canvas || document.getElementById('myCanvas');
		if (!canvasEl || !xeokitCanvas) {
			return;
		}

		const scale = xeokitCanvas.resolutionScale ?? 1;
		const width = canvasEl.clientWidth;
		const height = canvasEl.clientHeight;
		if (width <= 0 || height <= 0) {
			return;
		}

		canvasEl.width = Math.round(width * scale);
		canvasEl.height = Math.round(height * scale);
		applyNavCubeLayout(document.getElementById('myNavCubeCanvas'));
	}

	function scheduleViewerLayoutSync() {
		if (layoutSyncScheduled) {
			return;
		}
		layoutSyncScheduled = true;
		window.requestAnimationFrame(() => {
			layoutSyncScheduled = false;
			syncViewerLayout();
		});
	}

	function onLayoutChanged() {
		scheduleViewerLayoutSync();
		window.setTimeout(scheduleViewerLayoutSync, 320);
	}

	const layoutCanvas = document.getElementById('myCanvas');
	if (layoutCanvas && typeof ResizeObserver !== 'undefined') {
		new ResizeObserver(() => scheduleViewerLayoutSync()).observe(layoutCanvas);
	}
	if (viewerContainer && typeof ResizeObserver !== 'undefined') {
		new ResizeObserver(() => scheduleViewerLayoutSync()).observe(viewerContainer);
	}
	document.getElementById('explorer_toggle')?.addEventListener('change', onLayoutChanged);
	document.getElementById('inspector_toggle')?.addEventListener('change', onLayoutChanged);
	viewerContainer?.addEventListener('transitionend', (event) => {
		if (event.propertyName === 'left' || event.propertyName === 'right' || event.propertyName === 'width') {
			scheduleViewerLayoutSync();
		}
	});

	bimViewer.on('openExplorer', () => {
		const toggle = document.getElementById('explorer_toggle');
		if (toggle && !toggle.checked) {
			toggle.checked = true;
		}
		onLayoutChanged();
	});
	bimViewer.on('openInspector', () => {
		const toggle = document.getElementById('inspector_toggle');
		if (toggle && !toggle.checked) {
			toggle.checked = true;
		}
		document.querySelector('#myInspector .xeokit-propertiesTab')?.classList.add('active');
		onLayoutChanged();
	});

	bimViewer.viewer.scene.on('modelLoaded', () => {
		applyMaterialFriendlyViewerSettings(bimViewer);
		loadingTracker.setPercent(100);
		loadingTracker.setComplete(true);
		getBusyModal(bimViewer)?.dismiss?.();
		const metaScene = bimViewer.viewer.metaScene;
		const metaCount = Object.keys(metaScene.metaObjects).length;
		if (metaCount === 0) {
			console.error('[ifcviewer] Model loaded without metadata — Inspect Properties will not work');
			setStatus('Модель загружена без метаданных IFC. Свойства объектов недоступны.', true);
			return;
		}
		buildMetaObjectIndex(metaScene);
		patchMergedIfcExplorerLabels(bimViewer);
		fetch(`${apiBase}/status`, { credentials: 'same-origin' })
			.then((response) => (response.ok ? response.json() : null))
			.then((status) => {
				if (status?.externalMetadata) {
					syncExternalMetadataFlag(bimViewer, server, true);
				}
			})
			.catch(() => {});
	});

	loadingTracker.setError(window.__ifcviewerEarlyError || null);
	loadingTracker.setComplete(false);
	loadingTracker.setPercent(0);
	showBusyModal(bimViewer, '');

	bimViewer.loadProject(PROJECT_ID, () => {
		applyMaterialFriendlyViewerSettings(bimViewer);
		bimViewer.setControlsEnabled(true);
		bimViewer.setKeyboardEnabled(true);
		applyKeyboardNavigation(bimViewer);
		viewerShell?.focus({ preventScroll: true });
		bimViewer.openTab('storeys');
		bimViewer.resetView();
		collapseStoreysExplorer(bimViewer);
		ensureAllStoreysVisible(bimViewer);
		patchExplorerTreeHeader();
		onLayoutChanged();
		setStatus('', false);
		loadingTracker.setPercent(100);
		loadingTracker.setComplete(true);
		getBusyModal(bimViewer)?.dismiss?.();
	}, (errMsg) => {
		console.error('[ifcviewer] loadProject failed:', errMsg);
		loadingTracker.setError(formatViewerError(errMsg));
		loadingTracker.setComplete(false);
		showBusyModal(bimViewer, '');
		setStatus('', false);
	});
}

startViewer().catch((err) => {
	console.error('[ifcviewer]', err);
	setStatus('Failed to load viewer: ' + (err.message || err), true);
});
