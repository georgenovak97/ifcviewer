const root = document.getElementById('ifcviewer-app');
const src = root?.dataset?.viewerInit;
if (!src) {
	console.error('[ifcviewer] viewer-init URL missing (data-viewer-init)');
} else {
	import(src).catch((err) => {
		console.error('[ifcviewer] failed to load viewer-init:', err);
	});
}
