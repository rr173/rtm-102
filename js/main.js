(function() {
    function init() {
        const canvas = document.getElementById('pcb-canvas');

        Render.init(canvas);
        Interaction.init(canvas);
        Interaction.bindToolbarEvents();
        Interaction.initPanelResizer();

        PCBState.loadDemoData();

        DRC.runCheck();

        Render.render();
        Interaction.updateZoomDisplay();
        Interaction.updateDRCDisplay();
        Interaction.updateLayerButtons();
        Interaction.updateToolButtons();

        window.addEventListener('resize', () => {
            Render.render();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
