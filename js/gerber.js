const GerberExport = (function() {
    const SCALE = 1e6;

    function toGerberCoord(mm) {
        return Math.round(mm * SCALE);
    }

    function formatCoord(coord) {
        return coord.toString();
    }

    function collectApertures(state, layer) {
        const sizes = new Set();

        for (const track of state.tracks) {
            if (track.layer === layer) {
                sizes.add(track.width.toFixed(4));
            }
        }

        if (layer === 'front' || layer === 'back') {
            for (const pad of state.pads) {
                sizes.add(pad.diameter.toFixed(4));
            }
            for (const via of state.vias) {
                sizes.add(via.diameter.toFixed(4));
            }
        }

        const sortedSizes = Array.from(sizes)
            .map(s => parseFloat(s))
            .sort((a, b) => a - b);

        const apertureMap = {};
        let nextNum = 10;
        for (const size of sortedSizes) {
            apertureMap[size.toFixed(4)] = nextNum++;
        }

        return { apertureMap, sortedSizes };
    }

    function generateApertureDefinitions(apertureMap, sortedSizes) {
        let lines = [];
        lines.push('%FSLAX36Y36*%');
        lines.push('%MOMM*%');
        for (const size of sortedSizes) {
            const key = size.toFixed(4);
            const num = apertureMap[key];
            lines.push(`%ADD${num}C,${size.toFixed(4)}*%`);
        }
        return lines.join('\n') + '\n';
    }

    function generateLayerGerber(state, layer) {
        const { apertureMap, sortedSizes } = collectApertures(state, layer);
        let lines = [];

        lines.push('G04 Layer: ' + (layer === 'front' ? 'Top Copper' : 'Bottom Copper') + '*');
        lines.push(generateApertureDefinitions(apertureMap, sortedSizes));

        let currentAperture = null;
        let interpolationMode = null;

        for (const track of state.tracks) {
            if (track.layer !== layer) continue;
            if (track.points.length < 2) continue;

            const widthKey = track.width.toFixed(4);
            const apertureNum = apertureMap[widthKey];
            if (apertureNum === undefined) continue;

            if (currentAperture !== apertureNum) {
                lines.push(`D${apertureNum}*`);
                currentAperture = apertureNum;
            }
            if (interpolationMode !== 'G01') {
                lines.push('G01*');
                interpolationMode = 'G01';
            }

            const start = track.points[0];
            lines.push(`X${formatCoord(toGerberCoord(start.x))}Y${formatCoord(toGerberCoord(start.y))}D02*`);

            for (let i = 1; i < track.points.length; i++) {
                const pt = track.points[i];
                lines.push(`X${formatCoord(toGerberCoord(pt.x))}Y${formatCoord(toGerberCoord(pt.y))}D01*`);
            }
        }

        const padAndViaElements = [];
        for (const pad of state.pads) {
            padAndViaElements.push(pad);
        }
        for (const via of state.vias) {
            padAndViaElements.push(via);
        }

        for (const elem of padAndViaElements) {
            const diaKey = elem.diameter.toFixed(4);
            const apertureNum = apertureMap[diaKey];
            if (apertureNum === undefined) continue;

            if (currentAperture !== apertureNum) {
                lines.push(`D${apertureNum}*`);
                currentAperture = apertureNum;
            }

            lines.push(`X${formatCoord(toGerberCoord(elem.x))}Y${formatCoord(toGerberCoord(elem.y))}D03*`);
        }

        for (const pour of state.copperPours) {
            if (pour.layer !== layer) continue;
            if (pour.points.length < 3) continue;

            lines.push('G36*');

            const pts = pour.points;
            lines.push(`X${formatCoord(toGerberCoord(pts[0].x))}Y${formatCoord(toGerberCoord(pts[0].y))}D02*`);

            if (interpolationMode !== 'G01') {
                lines.push('G01*');
                interpolationMode = 'G01';
            }

            for (let i = 1; i < pts.length; i++) {
                lines.push(`X${formatCoord(toGerberCoord(pts[i].x))}Y${formatCoord(toGerberCoord(pts[i].y))}D01*`);
            }

            lines.push(`X${formatCoord(toGerberCoord(pts[0].x))}Y${formatCoord(toGerberCoord(pts[0].y))}D01*`);

            lines.push('G37*');
        }

        lines.push('M02*');
        return lines.join('\n');
    }

    function collectDrillTools(state) {
        const diameters = new Set();

        for (const pad of state.pads) {
            if (pad.hole > 0) {
                diameters.add(pad.hole.toFixed(4));
            }
        }
        for (const via of state.vias) {
            if (via.hole > 0) {
                diameters.add(via.hole.toFixed(4));
            }
        }

        const sortedDiameters = Array.from(diameters)
            .map(s => parseFloat(s))
            .sort((a, b) => a - b);

        const toolMap = {};
        sortedDiameters.forEach((dia, idx) => {
            toolMap[dia.toFixed(4)] = idx + 1;
        });

        return { toolMap, sortedDiameters };
    }

    function generateDrillFile(state) {
        const { toolMap, sortedDiameters } = collectDrillTools(state);
        let lines = [];

        lines.push('M48');
        lines.push(';DRILL FILE');
        lines.push('METRIC');
        lines.push(';TYPE=PLATED');

        for (const dia of sortedDiameters) {
            const key = dia.toFixed(4);
            const toolNum = toolMap[key];
            lines.push(`T${toolNum.toString().padStart(2, '0')}C${dia.toFixed(4)}`);
        }

        lines.push('%');
        lines.push('G90');
        lines.push('G05');

        const holesByTool = {};
        for (const key in toolMap) {
            holesByTool[toolMap[key]] = [];
        }

        for (const pad of state.pads) {
            if (pad.hole > 0) {
                const key = pad.hole.toFixed(4);
                const toolNum = toolMap[key];
                if (toolNum !== undefined) {
                    holesByTool[toolNum].push({ x: pad.x, y: pad.y });
                }
            }
        }
        for (const via of state.vias) {
            if (via.hole > 0) {
                const key = via.hole.toFixed(4);
                const toolNum = toolMap[key];
                if (toolNum !== undefined) {
                    holesByTool[toolNum].push({ x: via.x, y: via.y });
                }
            }
        }

        for (const toolNumStr in holesByTool) {
            const toolNum = parseInt(toolNumStr);
            const holes = holesByTool[toolNum];
            if (holes.length === 0) continue;

            lines.push(`T${toolNum.toString().padStart(2, '0')}`);
            for (const hole of holes) {
                lines.push(`X${hole.x.toFixed(4)}Y${hole.y.toFixed(4)}`);
            }
        }

        lines.push('M30');
        return lines.join('\n');
    }

    function isBoardEmpty(state) {
        return state.pads.length === 0 &&
               state.tracks.length === 0 &&
               state.vias.length === 0 &&
               state.copperPours.length === 0;
    }

    function exportGerber() {
        const state = PCBState.getState();

        if (isBoardEmpty(state)) {
            alert('板面为空,无法导出');
            return;
        }

        const topCopper = generateLayerGerber(state, 'front');
        const bottomCopper = generateLayerGerber(state, 'back');
        const drillFile = generateDrillFile(state);

        if (typeof JSZip === 'undefined') {
            alert('JSZip库未加载,无法导出');
            return;
        }

        const zip = new JSZip();
        zip.file('copper_top.gbr', topCopper);
        zip.file('copper_bottom.gbr', bottomCopper);
        zip.file('drill.drl', drillFile);

        zip.generateAsync({ type: 'blob' }).then(function(content) {
            const link = document.createElement('a');
            link.href = URL.createObjectURL(content);
            link.download = 'pcb_gerber.zip';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(link.href);
        }).catch(function(err) {
            alert('导出失败: ' + err.message);
        });
    }

    return {
        exportGerber,
        generateLayerGerber,
        generateDrillFile
    };
})();
