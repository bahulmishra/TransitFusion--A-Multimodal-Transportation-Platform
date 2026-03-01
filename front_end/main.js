// Global Map and State
let map;
let baseLayer;
let overlayLayers = [];
let currentService = 'WMS'; // WMS or WFS

document.addEventListener('DOMContentLoaded', () => {
    initMap();
    setupEventListeners();
});

function initMap() {
    baseLayer = new ol.layer.Tile({
        source: new ol.source.OSM()
    });

    map = new ol.Map({
        target: 'map',
        layers: [baseLayer],
        view: new ol.View({
            center: [0, 0],
            zoom: 2,
            projection: 'EPSG:4326' // Using EPSG:4326 to align with standard GeoServer/WMS bounds easily
        }),
        controls: ol.control.defaults.defaults({
            rotate: false // Disable default rotate to add custom our north arrow
        }).extend([
            new ol.control.ScaleLine({
                units: 'metric',
                bar: true,
                steps: 4,
                text: true,
                minWidth: 140
            }),
            new ol.control.Rotate({
                autoHide: false,
                label: '⬆ N', // Simple text-based north marker, or could be an icon/SVG
                className: 'custom-north-arrow ol-control'
            })
        ])
    });
}

function setupEventListeners() {
    // UI toggles
    document.getElementById('btn-wms').addEventListener('click', () => setService('WMS'));
    document.getElementById('btn-wfs').addEventListener('click', () => setService('WFS'));

    // Layers collapsible menu
    document.getElementById('btn-toggle-layers').addEventListener('click', function () {
        const content = document.getElementById('layers-container');
        content.classList.toggle('expanded');
        const icon = this.querySelector('.icon');
        icon.innerHTML = content.classList.contains('expanded') ? '&#9650;' : '&#9660;';
    });

    // Action buttons
    document.getElementById('btn-get-cap').addEventListener('click', fetchCapabilities);
    document.getElementById('btn-run-query').addEventListener('click', runQuery);
    document.getElementById('btn-clear-map').addEventListener('click', clearMap);
    document.getElementById('btn-clear-xml').addEventListener('click', clearXmlLog);

    // Feature Click logic for Vector Features
    map.on('singleclick', function (evt) {
        let featureFound = false;
        map.forEachFeatureAtPixel(evt.pixel, function (feature, layer) {
            featureFound = true;
            const properties = feature.getProperties();
            const geometryName = feature.getGeometryName();
            const id = feature.getId() || 'unknown';

            let xmlString = `<?xml version="1.0" encoding="UTF-8"?>\n<Feature id="${id}">\n`;
            for (const key in properties) {
                if (key !== geometryName && typeof properties[key] !== 'object') {
                    xmlString += `  <${key}>${properties[key]}</${key}>\n`;
                }
            }
            xmlString += `</Feature>`;

            document.getElementById('xml-raw-display').textContent = xmlString;
            document.getElementById('xml-summary').innerHTML = `<strong>Status:</strong> Clicked Feature ID: ${id}. Attribute properties auto-generated to XML below.`;
            return true;
        }, { hitTolerance: 5 });

        if (!featureFound) {
            clearXmlLog();
        }
    });

    // Change cursor on hover for Vector features
    map.on('pointermove', function (evt) {
        if (evt.dragging) return;
        const hit = map.hasFeatureAtPixel(evt.pixel, { hitTolerance: 5 });
        map.getTargetElement().style.cursor = hit ? 'pointer' : '';
    });
}

function setService(service) {
    currentService = service;

    // Toggle active state on buttons
    document.getElementById('btn-wms').classList.toggle('active', service === 'WMS');
    document.getElementById('btn-wfs').classList.toggle('active', service === 'WFS');

    // Update URL placeholder intelligently
    const urlInput = document.getElementById('server-url');
    if (urlInput.value.includes('geoserver/wms') && service === 'WFS') {
        urlInput.value = urlInput.value.replace('/wms', '/wfs');
    } else if (urlInput.value.includes('geoserver/wfs') && service === 'WMS') {
        urlInput.value = urlInput.value.replace('/wfs', '/wms');
    }

    // Toggle Size container (WMS only)
    document.getElementById('size-container').style.display = service === 'WMS' ? 'block' : 'none';

    // Toggle format options based on service
    const wmsOptions = document.querySelectorAll('.wms-option');
    const wfsOptions = document.querySelectorAll('.wfs-option');

    wmsOptions.forEach(opt => opt.style.display = service === 'WMS' ? 'block' : 'none');
    wfsOptions.forEach(opt => opt.style.display = service === 'WFS' ? 'block' : 'none');

    // Select first visible format automatically
    const formatSelect = document.getElementById('param-format');
    if (service === 'WMS') {
        formatSelect.value = 'image/png';
    } else {
        formatSelect.value = 'application/json';
    }
}

async function fetchCapabilities() {
    const baseUrl = document.getElementById('server-url').value.trim();
    if (!baseUrl) {
        alert('Please enter a Server URL');
        return;
    }

    showLoader(true);
    const summaryEl = document.getElementById('xml-summary');
    const rawEl = document.getElementById('xml-raw-display');

    try {
        // Construct standard GetCapabilities URL
        const url = new URL(baseUrl);
        url.searchParams.set('service', currentService);
        url.searchParams.set('request', 'GetCapabilities');
        if (currentService === 'WFS') {
            url.searchParams.set('version', '2.0.0'); // Standard WFS version override
        }

        summaryEl.innerHTML = `<strong>Status:</strong> Fetching capabilities from ${url.toString()}...`;

        const response = await fetch(url.toString(), {
            method: 'GET',
            mode: 'cors'
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const text = await response.text();

        // Display raw XML in the bottom panel
        rawEl.textContent = text;

        // Parse the XML document
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(text, "text/xml");

        // Check for XML parse errors
        const parseError = xmlDoc.getElementsByTagName("parsererror");
        if (parseError.length > 0) {
            throw new Error("Error parsing XML response content");
        }

        if (currentService === 'WMS') {
            parseWMSCapabilities(xmlDoc);
        } else {
            parseWFSCapabilities(xmlDoc);
        }

        summaryEl.innerHTML = `<strong>Status:</strong> Successfully parsed ${currentService} Capabilities. Layers updated in sidebar.`;

        // Auto-expand layers list for UI convenience
        document.getElementById('layers-container').classList.add('expanded');
        document.querySelector('.collapsible-btn .icon').innerHTML = '&#9650;';

    } catch (error) {
        console.error('Error fetching capabilities:', error);
        summaryEl.innerHTML = `<strong>ERROR:</strong> ${error.message}. <br>Did you enable CORS on your GeoServer?`;
        alert(`Failed to fetch GetCapabilities:\n${error.message}\n\nMake sure the server is running and CORS is enabled.`);
    } finally {
        showLoader(false);
    }
}

function parseWMSCapabilities(xmlDoc) {
    // Attempt to extract layers from distinct structure setups in standard WMS schema
    const layers = Array.from(xmlDoc.querySelectorAll('Capability > Layer > Layer, Capability Layer Layer'));

    // Fallback if nested structure not present
    const targetLayers = layers.length > 0 ? layers : Array.from(xmlDoc.querySelectorAll('Capability > Layer'));

    let layerData = [];

    targetLayers.forEach(layer => {
        const nameNode = layer.querySelector('Name');
        const titleNode = layer.querySelector('Title');
        if (nameNode && titleNode) {

            // Extract a BoundingBox if present
            let minx = '', miny = '', maxx = '', maxy = '';
            const bboxNode = layer.querySelector('BoundingBox, EX_GeographicBoundingBox, LatLonBoundingBox');
            if (bboxNode) {
                if (bboxNode.tagName === 'EX_GeographicBoundingBox') {
                    minx = bboxNode.querySelector('westBoundLongitude')?.textContent || '';
                    maxx = bboxNode.querySelector('eastBoundLongitude')?.textContent || '';
                    miny = bboxNode.querySelector('southBoundLatitude')?.textContent || '';
                    maxy = bboxNode.querySelector('northBoundLatitude')?.textContent || '';
                } else {
                    minx = bboxNode.getAttribute('minx') || '';
                    miny = bboxNode.getAttribute('miny') || '';
                    maxx = bboxNode.getAttribute('maxx') || '';
                    maxy = bboxNode.getAttribute('maxy') || '';
                }
            }

            layerData.push({
                name: nameNode.textContent,
                title: titleNode.textContent,
                minx, miny, maxx, maxy
            });
        }
    });

    renderLayersList(layerData);
}

function parseWFSCapabilities(xmlDoc) {
    // WFS typically stores options under FeatureTypeList > FeatureType
    const featureTypes = Array.from(xmlDoc.querySelectorAll('FeatureType'));
    let layerData = [];

    featureTypes.forEach(ft => {
        const nameNode = ft.querySelector('Name');
        const titleNode = ft.querySelector('Title');

        let minx = '', miny = '', maxx = '', maxy = '';
        const bboxNode = ft.querySelector('WGS84BoundingBox > LowerCorner, WGS84BoundingBox > UpperCorner');
        if (ft.querySelector('WGS84BoundingBox')) {
            const lowerNode = ft.querySelector('LowerCorner');
            const upperNode = ft.querySelector('UpperCorner');
            if (lowerNode && upperNode) {
                const lower = lowerNode.textContent.split(' ');
                const upper = upperNode.textContent.split(' ');
                // WFS standard orders Lon Lat
                minx = lower[0]; miny = lower[1];
                maxx = upper[0]; maxy = upper[1];
            }
        }

        if (nameNode && titleNode) {
            layerData.push({
                name: nameNode.textContent,
                title: titleNode.textContent,
                minx, miny, maxx, maxy
            });
        }
    });

    renderLayersList(layerData);
}

function renderLayersList(layers) {
    const container = document.getElementById('layers-container');
    container.innerHTML = ''; // Clear previous items

    if (layers.length === 0) {
        container.innerHTML = '<p class="empty-state">No layers found in capabilities document.</p>';
        return;
    }

    layers.forEach((layer, index) => {
        const label = document.createElement('label');
        label.className = 'layer-item';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.name = 'selected_layers';
        checkbox.value = layer.name;
        // Data attributes for filling UI inputs later
        checkbox.dataset.minx = layer.minx;
        checkbox.dataset.miny = layer.miny;
        checkbox.dataset.maxx = layer.maxx;
        checkbox.dataset.maxy = layer.maxy;

        // Select the first layer by default
        if (index === 0) checkbox.checked = true;

        checkbox.addEventListener('change', handleLayerSelection);

        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(` ${layer.title} (${layer.name})`));
        container.appendChild(label);
    });

    // Trigger pre-fill of inputs for the automatically selected layer
    handleLayerSelection();
}

function handleLayerSelection() {
    // Populate the Bound Box inputs with the metadata from the first checked layer
    const checked = document.querySelector('input[name="selected_layers"]:checked');
    if (checked) {
        const minxField = document.getElementById('bbox-minx');
        const minyField = document.getElementById('bbox-miny');
        const maxxField = document.getElementById('bbox-maxx');
        const maxyField = document.getElementById('bbox-maxy');

        // Only fill if not explicitly altered by the user OR default behavior to overwrite
        minxField.value = checked.dataset.minx || '';
        minyField.value = checked.dataset.miny || '';
        maxxField.value = checked.dataset.maxx || '';
        maxyField.value = checked.dataset.maxy || '';

        // Optional: animate Map view to this bbox if we have valid coordinates
        if (checked.dataset.minx && checked.dataset.miny && checked.dataset.maxx && checked.dataset.maxy) {
            const extent = [
                parseFloat(checked.dataset.minx),
                parseFloat(checked.dataset.miny),
                parseFloat(checked.dataset.maxx),
                parseFloat(checked.dataset.maxy)
            ];

            if (!extent.some(isNaN)) {
                try {
                    map.getView().fit(extent, { padding: [50, 50, 50, 50], duration: 1000 });
                } catch (e) {
                    console.log("Could not animate map to extent:", e);
                }
            }
        }
    }
}

function runQuery() {
    const baseUrl = document.getElementById('server-url').value.trim();
    if (!baseUrl) {
        alert("Server URL is missing.");
        return;
    }

    const checkboxes = document.querySelectorAll('input[name="selected_layers"]:checked');
    if (checkboxes.length === 0) {
        alert("Please select at least one layer to render.");
        return;
    }

    const layerNames = Array.from(checkboxes).map(c => c.value);

    // Clear previous layers to only show the selected one
    clearMap();

    if (currentService === 'WMS') {
        runWMSQuery(baseUrl, layerNames);
    } else {
        runWFSQuery(baseUrl, layerNames);
    }
}

function runWMSQuery(baseUrl, layerNames) {
    const format = document.getElementById('param-format').value;
    const srs = document.getElementById('param-srs').value;

    // Loop through requested layer names and create an individual OL Image layer for each
    // This allows them to be individually toggled in the layer switcher box
    layerNames.forEach(layerName => {
        const wmsSource = new ol.source.ImageWMS({
            url: baseUrl,
            params: {
                'LAYERS': layerName,
                'FORMAT': format,
                'SRS': srs
            },
            ratio: 1,
            serverType: 'geoserver' // Ensures vendor-params optimized for GeoServer
        });

        const wmsLayer = new ol.layer.Image({
            source: wmsSource,
            opacity: 0.8
        });

        map.addLayer(wmsLayer);
        overlayLayers.push(wmsLayer);
        addLayerToSwitcher(layerName, wmsLayer);
    });

    document.getElementById('xml-summary').innerHTML = `<strong>Status:</strong> Added WMS Image Layers: [${layerNames.join(', ')}] with format ${format}`;
}

async function runWFSQuery(baseUrl, layerNames) {
    showLoader(true);

    const format = document.getElementById('param-format').value; // Usually application/json
    const srs = document.getElementById('param-srs').value;

    try {
        for (let layerName of layerNames) {
            const url = new URL(baseUrl);
            url.searchParams.set('service', 'WFS');
            url.searchParams.set('version', '1.0.0');
            url.searchParams.set('request', 'GetFeature');
            url.searchParams.set('typeName', layerName);
            url.searchParams.set('outputFormat', format);
            url.searchParams.set('srsName', srs);

            document.getElementById('xml-summary').innerHTML = `<strong>Status:</strong> Fetching WFS feature [${layerName}]...`;

            // Instruct OL to load the dynamic URL
            const vectorSource = new ol.source.Vector({
                format: new ol.format.GeoJSON(),
                url: url.toString()
            });

            // Randomly styled layers to differentiate
            const r = Math.floor(Math.random() * 200);
            const g = Math.floor(Math.random() * 200);
            const b = Math.floor(Math.random() * 200);

            const vectorStyle = new ol.style.Style({
                stroke: new ol.style.Stroke({
                    color: `rgba(${r}, ${g}, ${b}, 1.0)`,
                    width: 2
                }),
                fill: new ol.style.Fill({
                    color: `rgba(${r}, ${g}, ${b}, 0.2)`
                }),
                image: new ol.style.Circle({
                    radius: 5,
                    fill: new ol.style.Fill({ color: `rgba(${r}, ${g}, ${b}, 0.8)` }),
                    stroke: new ol.style.Stroke({ color: '#fff', width: 1 })
                })
            });

            const vectorLayer = new ol.layer.Vector({
                source: vectorSource,
                style: vectorStyle
            });

            vectorSource.on('featuresloaderror', function () {
                console.error(`Error loading features for ${layerName}`);
                alert(`Error loading features for ${layerName}.\nPossible CORS issue, invalid GeoJSON formatting from the WFS, or the layer is empty.`);
            });

            map.addLayer(vectorLayer);
            overlayLayers.push(vectorLayer);
            addLayerToSwitcher(layerName, vectorLayer);
        }

        document.getElementById('xml-summary').innerHTML = `<strong>Status:</strong> Successfully requested WFS Vector Layer(s). Features will appear shortly if valid geometries are returned.`;

    } catch (e) {
        console.error(e);
        alert("Failed to enqueue WFS layer request:\n" + e.message);
    } finally {
        showLoader(false);
    }
}

function clearMap() {
    overlayLayers.forEach(layer => {
        map.removeLayer(layer);
    });
    overlayLayers = [];
    document.getElementById('xml-summary').innerHTML = `<strong>Status:</strong> Map overlays cleared.`;

    // Clear the layer switcher overlay
    document.getElementById('layer-switcher-content').innerHTML = '';
    document.getElementById('layer-switcher').classList.add('hidden');
}

function clearXmlLog() {
    document.getElementById('xml-raw-display').textContent = 'Raw XML will appear here...';
    document.getElementById('xml-summary').innerHTML = `<strong>Status:</strong> Log cleared.`;
}

// Minimal loader component control
function showLoader(show) {
    const loader = document.getElementById('loader');
    if (show) {
        loader.classList.remove('hidden');
    } else {
        loader.classList.add('hidden');
    }
}

// Map overlay Layer Switcher Logic
function addLayerToSwitcher(title, layer) {
    const switcher = document.getElementById('layer-switcher');
    const content = document.getElementById('layer-switcher-content');

    switcher.classList.remove('hidden');

    const label = document.createElement('label');
    label.className = 'switcher-item';

    const switchDiv = document.createElement('div');
    switchDiv.className = 'toggle-switch';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true; // Layers are visible by default
    checkbox.addEventListener('change', (e) => {
        layer.setVisible(e.target.checked);
    });

    const slider = document.createElement('span');
    slider.className = 'slider';

    switchDiv.appendChild(checkbox);
    switchDiv.appendChild(slider);

    const titleSpan = document.createElement('span');
    titleSpan.className = 'layer-title';
    titleSpan.textContent = title;

    label.appendChild(switchDiv);
    label.appendChild(titleSpan);
    content.appendChild(label);
}
