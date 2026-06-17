/**
 * IFC file action for Nextcloud Files (v0.5.33).
 * Registers the default click handler via the shared Files scope.
 */
(function () {
	'use strict';

	document.getElementById('ifcviewer-overlay')?.remove();
	document.body.classList.remove('ifcviewer-overlay-open');

	const IFC_MIMES = ['model/ifc', 'application/ifc', 'application/x-ifc'];
	const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12,2L2,7V17L12,22L22,17V7L12,2M12,4.15L19.47,7.96L12,11.77L4.53,7.96L12,4.15M4,9.19V16.81L11,20.34V12.77L4,9.19M13,20.34L20,16.81V9.19L13,12.77V20.34Z" /></svg>';
	const DefaultType = Object.freeze({ DEFAULT: 'default', HIDDEN: 'hidden' });
	const ACTION_ID = 'ifcviewer-open';

	function translate(text) {
		if (typeof OC !== 'undefined' && OC.L10N && OC.L10N.translate) {
			return OC.L10N.translate('ifcviewer', text);
		}
		return text;
	}

	function getFileId(node) {
		const raw = node?.fileid ?? node?.fileId ?? node?.id;
		const fileId = Number(raw);
		return Number.isFinite(fileId) && fileId > 0 ? fileId : 0;
	}

	function hasReadPermission(node) {
		if (!node || typeof node.permissions !== 'number') {
			return true;
		}
		return (node.permissions & 1) !== 0;
	}

	function isIfcNode(node) {
		if (!node) {
			return false;
		}
		const name = String(node.basename || node.displayname || node.attributes?.displayname || '').toLowerCase();
		if (name.endsWith('.ifc')) {
			return true;
		}
		const mime = String(node.mime || node.mimetype || node.attributes?.mimetype || '');
		return IFC_MIMES.includes(mime);
	}

	function getFilesScope() {
		window._nc_files_scope ??= {};
		window._nc_files_scope.v4_0 ??= {};
		return window._nc_files_scope.v4_0;
	}

	function getFilesRegistry(scope) {
		if (!scope.registry) {
			class FilesRegistry extends EventTarget {
				dispatchTypedEvent(type, event) {
					return super.dispatchEvent(event);
				}
			}
			scope.registry = new FilesRegistry();
		}
		return scope.registry;
	}

	function validateFileAction(action) {
		if (!action.id || typeof action.id !== 'string') {
			throw new Error('Invalid id');
		}
		if (!action.displayName || typeof action.displayName !== 'function') {
			throw new Error('Invalid displayName function');
		}
		if (!action.iconSvgInline || typeof action.iconSvgInline !== 'function') {
			throw new Error('Invalid iconSvgInline function');
		}
		if (!action.exec || typeof action.exec !== 'function') {
			throw new Error('Invalid exec function');
		}
		if ('enabled' in action && typeof action.enabled !== 'function') {
			throw new Error('Invalid enabled function');
		}
		if (action.default && !Object.values(DefaultType).includes(action.default)) {
			throw new Error('Invalid default');
		}
	}

	function registerFileAction(action) {
		const scope = getFilesScope();
		validateFileAction(action);
		scope.fileActions ??= new Map();
		if (scope.fileActions.has(action.id)) {
			console.error(`[ifcviewer] FileAction ${action.id} already registered`, { action });
			return false;
		}
		scope.fileActions.set(action.id, action);
		getFilesRegistry(scope).dispatchTypedEvent(
			'register:action',
			new CustomEvent('register:action', { detail: action }),
		);
		return true;
	}

	function openIfcViewer(fileId) {
		const url = OC.generateUrl('/apps/ifcviewer/{fileId}', { fileId });
		window.location.assign(url);
	}

	function registerIfcAction() {
		return registerFileAction({
			id: ACTION_ID,
			displayName: () => translate('View IFC model'),
			iconSvgInline: () => ICON,
			enabled: ({ nodes }) => {
				if (!nodes || nodes.length !== 1) {
					return false;
				}
				const node = nodes[0];
				return isIfcNode(node) && hasReadPermission(node) && getFileId(node) > 0;
			},
			async exec({ nodes }) {
				const fileId = getFileId(nodes[0]);
				if (fileId <= 0) {
					return null;
				}
				openIfcViewer(fileId);
				return null;
			},
			default: DefaultType.DEFAULT,
			order: -100,
		});
	}

	function bootstrap(attempt = 0) {
		if (typeof OC === 'undefined' || !OC.generateUrl) {
			if (attempt >= 20) {
				console.error('[ifcviewer] OC is not available, cannot register IFC file action');
			} else {
				window.setTimeout(() => bootstrap(attempt + 1), 100);
			}
			return;
		}

		if (registerIfcAction()) {
			return;
		}

		if (attempt >= 8) {
			return;
		}
		window.setTimeout(() => bootstrap(attempt + 1), 250 * (attempt + 1));
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', () => bootstrap());
	} else {
		bootstrap();
	}
})();
