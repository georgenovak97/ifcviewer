/**
 * Public share page — add "View IFC" button for shared IFC files
 */
(function () {
    'use strict';

    document.addEventListener('DOMContentLoaded', function () {
        const token = OC.getSharingToken && OC.getSharingToken();
        if (!token) {
            return;
        }

        const viewerUrl = OC.generateUrl('/apps/ifcviewer/s/{token}', { token: token });

        const btn = document.createElement('a');
        btn.href = viewerUrl;
        btn.className = 'button primary';
        btn.textContent = 'View IFC model';
        btn.style.margin = '12px';
        btn.style.display = 'inline-block';

        const header = document.getElementById('header') || document.querySelector('.header-appname') || document.body;
        if (header.firstChild) {
            header.insertBefore(btn, header.firstChild.nextSibling);
        } else {
            header.appendChild(btn);
        }
    });
})();
